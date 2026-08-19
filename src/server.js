// Entry point for the SOLO Panel web server.
//
// Railway requirement: the app must listen on 0.0.0.0:$PORT.
// See docs/how-program-work.md for the networking rationale.
'use strict';

const path = require('path');
const http = require('http');
const net = require('net');
const express = require('express');
const session = require('express-session');
const { getOrCreateSessionSecret } = require('./db'); // also initializes SQLite DB and tables on startup
const { seedAdminFromEnv, verifyLogin, requireAuth, getOrCreateCsrfToken, requireCsrf } = require('./auth');
const inbounds = require('./inbounds');
const { listCores } = require('./cores');
const { orderInbounds } = require('./priority');
const { buildAllClientLinks, buildLinksForInbound, labelForInbound } = require('./xray/links');
const { internalPortForRow } = require('./cores/ports');
const { attachProxy } = require('./xray/proxy');
const statsPoller = require('./xray/statsPoller');
const healthMonitor = require('./healthMonitor');
const { getAllHealth } = require('./health');
const { formatBytes, QR_ICON_SVG, regionFlag, regionName, explainField } = require('./utils');

// The public host clients connect to. Railway sets RAILWAY_PUBLIC_DOMAIN
// automatically for the service's HTTPS domain; falling back to the
// request's Host header covers local dev / custom-domain setups. No
// admin input needed either way (see docs/how-program-work.md).
function externalHostFor(req) {
  return process.env.RAILWAY_PUBLIC_DOMAIN || req.get('host');
}

seedAdminFromEnv();

const app = express();
// Created explicitly (instead of via app.listen). Doesn't listen
// directly — see tcpServer below, which accepts every connection
// first so attachProxy() can sniff `raw`-transport traffic before
// this server's own HTTP/upgrade parsing ever sees it (see
// src/xray/proxy.js).
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
// (matched by path) straight to the matching inbound's internal core
// process (xray or sing-box, via internalPortForRow), bypassing the
// rest of the panel's middleware chain entirely.
const { xhttpMiddleware, handleConnection } = attachProxy(server, inbounds.listInbounds, internalPortForRow);
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

// Public subscription endpoint (raw feed): no auth, meant to be
// pasted into a client app's "subscribe" URL field. Returns every
// configured inbound's client share link, one per line, base64-
// encoded as a whole (the standard multi-server subscription
// format), or 404 if the token doesn't match. Kept at a separate path
// from the browser-facing panel below (vision rule 18: "the Web Panel
// must not break compatibility with subscription clients").
app.get('/sub/:subId/raw', (req, res) => {
  if (req.params.subId !== inbounds.getOrCreateGlobalSubscriptionId()) {
    return res.status(404).send('Not found');
  }

  const links = buildAllClientLinks(orderInbounds(inbounds.listInbounds()), externalHostFor(req));
  res.type('text/plain').send(Buffer.from(links.join('\n')).toString('base64'));
});

// Public subscription endpoint (browser panel): no auth. This is the
// URL the user is meant to open directly (vision rules 13/14: "the
// subscription URL is also a web panel") -- it shows a read-only
// dashboard with one card per endpoint, a representative link
// (the first ALPN/fingerprint variant; the rest remain available via
// the raw feed above), human-friendly technical details, and health
// status. 404s on a bad token, same as the raw feed.
app.get('/sub/:subId', (req, res) => {
  const subId = req.params.subId;
  if (subId !== inbounds.getOrCreateGlobalSubscriptionId()) {
    return res.status(404).send('Not found');
  }

  const externalHost = externalHostFor(req);
  const health = getAllHealth();
  const orderedRows = orderInbounds(inbounds.listInbounds());
  const endpoints = orderedRows.map((row) => {
    const links = buildLinksForInbound({ inbound: row, externalHost });
    return {
      id: row.id,
      label: labelForInbound(row),
      core: row.core,
      protocol: row.protocol,
      transport: row.transport,
      link: links[0] || null,
      variantCount: links.length,
      health: health[row.id] || { status: 'unknown' },
    };
  });
  const activeCount = endpoints.filter((e) => e.health.status === 'healthy' || e.health.status === 'degraded').length;
  // Overall system status shown at the top of the panel: unavailable
  // if nothing at all is reachable, degraded if some but not all
  // endpoints are, operational if every endpoint is healthy/degraded
  // (i.e. reachable). Reuses the same health-status vocabulary as
  // individual endpoints (src/health.js) via the existing
  // .health-badge/.health-* CSS classes.
  const systemStatus = activeCount === 0 ? 'unavailable' : activeCount < endpoints.length ? 'degraded' : 'healthy';

  res.render('subscription', {
    loggedIn: false,
    subId,
    rawSubLink: `${req.protocol}://${req.get('host')}/sub/${subId}/raw`,
    location: `${regionFlag()} ${regionName()}`.trim(),
    endpoints,
    activeCount,
    totalCount: endpoints.length,
    systemStatus,
    explainField,
    qrIconSvg: QR_ICON_SVG,
  });
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
  const health = getAllHealth();
  const rows = orderInbounds(inbounds.listInbounds()).map((row) => ({
    ...row,
    label: labelForInbound(row),
    internalPort: internalPortForRow(row),
    links: buildLinksForInbound({ inbound: row, externalHost }),
    totalTraffic: formatBytes(row.up_bytes + row.down_bytes),
    health: health[row.id] || { status: 'unknown' },
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

// The actual publicly-listening socket. Every accepted connection
// goes to handleConnection() first (see src/xray/proxy.js), which
// sniffs for `raw`-transport camouflage traffic at the TCP level and
// hands anything else to `server` unchanged.
const tcpServer = net.createServer(handleConnection);

tcpServer.listen(PORT, HOST, () => {
  console.log(`SOLO Panel listening on http://${HOST}:${PORT}`);
});

// Seed the fixed set of auto-generated inbounds (no-op after first
// boot), then start every registered core with its own rows (see
// src/cores/index.js and inbounds.reloadCores()).
inbounds.ensureGeneratedInbounds();
inbounds.reloadCores().catch((err) => {
  console.error('Failed to start cores on boot:', err.message);
});

// Periodically pull per-client traffic counters from every core's
// Stats API and persist them (see src/xray/statsPoller.js).
statsPoller.start();

// Periodically check every generated endpoint's reachability (see
// src/healthMonitor.js and docs/product-vision.md rule 10).
healthMonitor.start();

async function shutdown() {
  console.log('Shutting down: stopping all cores...');
  statsPoller.stop();
  healthMonitor.stop();
  await Promise.all(listCores().map((core) => core.stop()));
  tcpServer.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
