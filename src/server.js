// Entry point for the SOLO Panel web server.
//
// Railway requirement: the app must listen on 0.0.0.0:$PORT.
// See docs/how-program-work.md for the networking rationale.
'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');
const { getOrCreateSessionSecret } = require('./db'); // also initializes SQLite DB and tables on startup
const { seedAdminFromEnv, verifyLogin, requireAuth } = require('./auth');
const inbounds = require('./inbounds');
const manager = require('./xray/manager');
const { buildClientLink, labelForInbound } = require('./xray/links');
const { internalPortForInbound } = require('./xray/config');
const statsPoller = require('./xray/statsPoller');
const { formatBytes, QR_ICON_SVG } = require('./utils');

seedAdminFromEnv();

const app = express();

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.set('view engine', 'ejs');
app.set('views', `${__dirname}/views`);
// Railway terminates TLS at its edge and forwards plain HTTP with an
// X-Forwarded-Proto header; trusting the proxy lets express-session
// correctly mark cookies secure in production.
app.set('trust proxy', 1);

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
// client app's "subscribe" URL field. Returns the inbound's client
// share link base64-encoded (the standard subscription format most
// VPN client apps expect), or 404 if the token doesn't match.
app.get('/sub/:subId', (req, res) => {
  const inbound = inbounds.getInboundBySubscriptionId(req.params.subId);
  if (!inbound) return res.status(404).send('Not found');

  const publicHost = req.get('host');
  const link = buildClientLink({ inbound, publicHost });
  res.type('text/plain').send(Buffer.from(link).toString('base64'));
});

app.get('/login', (req, res) => {
  if (req.session && req.session.adminId) {
    return res.redirect('/');
  }
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = verifyLogin(username, password);

  if (!user) {
    return res.render('login', { error: 'Invalid username or password.' });
  }

  req.session.adminId = user.id;
  req.session.username = user.username;
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

app.get('/', requireAuth, (req, res) => {
  const publicHost = req.get('host');
  const rows = inbounds.listInbounds().map((row) => ({
    ...row,
    label: labelForInbound(row),
    internalPort: internalPortForInbound(row.id),
    link: buildClientLink({ inbound: row, publicHost }),
    subLink: `${req.protocol}://${publicHost}/sub/${row.subscription_id}`,
    totalTraffic: formatBytes(row.up_bytes + row.down_bytes),
  }));
  res.render('dashboard', {
    username: req.session.username,
    inbounds: rows,
    qrIconSvg: QR_ICON_SVG,
    formatBytes,
  });
});

// Saves the Railway-assigned external host/port for this inbound's
// Railway TCP Proxy, once the admin has manually set that up pointing
// at this inbound's internal port.
app.post('/inbounds/:id/external', requireAuth, (req, res) => {
  const { externalHost, externalPort } = req.body;
  if (externalHost && externalPort) {
    inbounds.setInboundExternalAddress(req.params.id, externalHost, Number(externalPort));
  }
  res.redirect('/');
});

const server = app.listen(PORT, HOST, () => {
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
