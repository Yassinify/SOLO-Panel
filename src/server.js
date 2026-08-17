// Entry point for the SOLO Panel web server.
//
// Railway requirement: the app must listen on 0.0.0.0:$PORT.
// See docs/how-program-work.md for the networking rationale.
'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const { getOrCreateSessionSecret } = require('./db'); // also initializes SQLite DB and tables on startup
const { seedAdminFromEnv, verifyLogin, requireAuth, getOrCreateCsrfToken, requireCsrf } = require('./auth');
const inbounds = require('./inbounds');
const manager = require('./xray/manager');
const { buildAllClientLinks, buildLinksForInbound, labelForInbound } = require('./xray/links');
const { internalPortForInbound } = require('./xray/config');
const { attachProxy } = require('./xray/proxy');
const statsPoller = require('./xray/statsPoller');
const { formatBytes, QR_ICON_SVG } = require('./utils');

// The public host clients connect to. Railway sets RAILWAY_PUBLIC_DOMAIN
// automatically for the service's HTTPS domain; falling back to the
// request's Host header covers local dev / custom-domain setups. No
// admin input needed either way (see docs/how-program-work.md).
function externalHostFor(req) {
  return process.env.RAILWAY_PUBLIC_DOMAIN || req.get('host');
}

seedAdminFromEnv();

const app = express();
// Created explicitly (instead of via app.listen) so attachProxy() can
// hook the 'upgrade' event before the server starts accepting
// connections — see src/xray/proxy.js.
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.set('view engine', 'ejs');
app.set('views', `${__dirname}/views`);
// Railway terminates TLS at its edge and forwards plain HTTP with an
// X-Forwarded-Proto header; trusting the proxy lets express-session
// correctly mark cookies secure in production.
app.set('trust proxy', 1);

// Must run before static/session/routes: forwards XHTTP requests
// (matched by path) straight to the matching xray-core inbound,
// bypassing the rest of the panel's middleware chain entirely.
const xhttpMiddleware = attachProxy(server, inbounds.listInbounds, internalPortForInbound);
app.use(xhttpMiddleware);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false }));

// Prefer SESSION_SECRET from the environment if set. Otherwise fall
// back to a secret that's generated once and persisted in the DB, so
// forks/deployments that don't set this still get a real random
// per-deployment secret (not a shared hardcoded one) and sessions
// survive restarts as long as DATA_DIR is on a persistent Volume.
const sessionSecret = process.env.SESSION_SECRET || getOrCreateSessionSecret();
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  },
}));

// Basic health check endpoint (used to verify the service is up on Railway).
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Public subscription endpoint: no auth, meant to be pasted into a
// client app's "subscribe" URL field. Returns every configured
// inbound's client share link, one per line, base64-encoded as a
// whole (the standard multi-server subscription format), or 404 if
// the token doesn't match.
app.get('/sub/:subId', (req, res) => {
  if (req.params.subId !== inbounds.getOrCreateGlobalSubscriptionId()) {
    return res.status(404).send('Not found');
  }

  const links = buildAllClientLinks(inbounds.listInbounds(), externalHostFor(req));
  res.type('text/plain').send(Buffer.from(links.join('\n')).toString('base64'));
});

app.get('/login', (req, res) => {
  if (req.session && req.session.adminId) {
    return res.redirect('/');
  }
  res.render('login', { error: null, csrfToken: getOrCreateCsrfToken(req) });
});

app.post('/login', requireCsrf, (req, res) => {
  const { password } = req.body;
  const user = verifyLogin(password);

  if (!user) {
    return res.render('login', { error: 'Invalid password.', csrfToken: getOrCreateCsrfToken(req) });
  }

  req.session.adminId = user.id;
  res.redirect('/');
});

app.post('/logout', requireCsrf, (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

app.get('/', requireAuth, (req, res) => {
  const externalHost = externalHostFor(req);
  const rows = inbounds.listInbounds().map((row) => ({
    ...row,
    label: labelForInbound(row),
    internalPort: internalPortForInbound(row.id),
    links: buildLinksForInbound({ inbound: row, externalHost }),
    totalTraffic: formatBytes(row.up_bytes + row.down_bytes),
  }));
  const subLink = `${req.protocol}://${req.get('host')}/sub/${inbounds.getOrCreateGlobalSubscriptionId()}`;
  res.render('dashboard', {
    loggedIn: true,
    csrfToken: getOrCreateCsrfToken(req),
    inbounds: rows,
    externalHost,
    subLink,
    qrIconSvg: QR_ICON_SVG,
    formatBytes,
  });
});

server.listen(PORT, HOST, () => {
  console.log(`SOLO Panel listening on http://${HOST}:${PORT}`);
});

// Seed the fixed set of auto-generated inbounds (no-op after first
// boot), then start xray-core with them.
inbounds.ensureGeneratedInbounds();
inbounds.reloadXray().catch((err) => {
  console.error('Failed to start xray-core on boot:', err.message);
});

// Periodically pull per-client traffic counters from xray-core's Stats
// API and persist them (see src/xray/statsPoller.js).
statsPoller.start();

async function shutdown() {
  console.log('Shutting down: stopping xray-core...');
  statsPoller.stop();
  await manager.stop();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
