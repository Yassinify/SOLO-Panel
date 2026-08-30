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
const { version: APP_VERSION } = require('../package.json');
const { seedAdminFromEnv, verifyLogin, requireAuth, getOrCreateCsrfToken, requireCsrf } = require('./auth');
const SqliteSessionStore = require('./sessionStore');
const inbounds = require('./inbounds');
const { listCores } = require('./cores');
const { orderInbounds } = require('./priority');
const { buildAllClientLinks, buildLinksForInbound, buildUsageInfoLink, labelForInbound } = require('./xray/links');
const { internalPortForRow } = require('./cores/ports');
const { attachProxy } = require('./xray/proxy');
const statsPoller = require('./xray/statsPoller');
const healthMonitor = require('./healthMonitor');
const { getAllHealth } = require('./health');
const { formatBytes, QR_ICON_SVG, regionFlag, regionName, explainField } = require('./utils');
const { MODE_DIMENSIONS, getModeState, setModeState, isRowEnabled, emptyDimensions, labelForMode, getEnabledAlpnValues, getEnabledFingerprints } = require('./modes');
const { getLimits, setLimits, getUsageSummary } = require('./subscriptionLimits');

// The public host clients connect to. Railway sets RAILWAY_PUBLIC_DOMAIN
// automatically for the service's HTTPS domain; falling back to the
// request's Host header covers local dev / custom-domain setups. No
// admin input needed either way (see docs/how-program-work.md).
function externalHostFor(req) {
  return process.env.RAILWAY_PUBLIC_DOMAIN || req.get('host');
}

// Distinguishes a real web browser from a VPN client app fetching the
// subscription feed, so one URL can serve both (vision rule 18 allows
// this: "the exact implementation may differ" as long as opening the
// link in a browser shows the panel). Every mainstream browser's User-
// Agent starts with "Mozilla/5.0" for historical reasons; proxy client
// apps (v2rayNG, Shadowrocket, Clash, sing-box, NekoBox, etc.) send
// their own app name instead, not a Mozilla-style UA. Same technique
// BPB-Worker-Panel uses (referenced earlier in this project's own
// Change Log) for the same one-URL-does-both design.
function isBrowserRequest(req) {
  return /Mozilla/i.test(req.get('user-agent') || '');
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
// Available to every view (including partials/header.ejs's <title>)
// without each res.render() call needing to pass it explicitly, so
// the displayed version can never drift from package.json's again.
app.locals.appVersion = APP_VERSION;
// Railway terminates TLS at its edge and forwards plain HTTP with an
// X-Forwarded-Proto header; trusting the proxy lets express-session
// correctly mark cookies secure in production.
app.set('trust proxy', 1);

// Must run before static/session/routes: forwards XHTTP requests
// (matched by path) straight to the matching inbound's internal core
// process (via internalPortForRow), bypassing the rest of the panel's
// middleware chain entirely.
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
  store: new SqliteSessionStore(), // persists sessions in SQLite instead of the default in-memory MemoryStore, so a redeploy/restart doesn't log the admin out (see src/sessionStore.js)
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

// Public subscription endpoint. No auth, single URL for everyone --
// content-negotiated by User-Agent (see isBrowserRequest() above):
// a real browser gets the HTML Web Panel (vision rules 13/14: "the
// subscription URL is also a web panel"); a VPN client app fetching
// it as a subscription gets the raw base64 link feed instead (vision
// rule 18: must not break compatibility with subscription clients).
// `/sub/:subId/raw` below still works too, as a explicit-raw alias
// for any subscription already saved with that exact URL.
function sendRawSubscription(req, res) {
  // Rows whose mode (protocol/transport) is currently disabled
  // via src/modes.js are left out of the subscription entirely --
  // that's the whole point of disabling a mode. See docs/how-program-
  // work.md for this user-requested exception to vision rules 7/20.
  const enabledRows = inbounds.listInbounds().filter((row) => isRowEnabled(row));
  const links = buildAllClientLinks(orderInbounds(enabledRows), externalHostFor(req), getEnabledAlpnValues(), getEnabledFingerprints());

  // Leading informational entry (non-functional, 127.0.0.1:443 --
  // see buildUsageInfoLink()'s own header) so a client app's own
  // server list shows the current days-left/usage-left figures
  // directly, per user request.
  const usageSummary = getUsageSummary(inbounds.getTotalTrafficBytes());
  const usageInfoLink = buildUsageInfoLink(
    `\ud83d\udcc5 ${usageSummary.unlimitedDays ? 'Unlimited' : `${usageSummary.daysLeft} Days`}  \ud83d\udcca ${usageSummary.unlimitedUsage ? 'Unlimited' : formatBytes(usageSummary.usageLeftBytes)}`
  );

  res.type('text/plain').send(Buffer.from([usageInfoLink, ...links].join('\n')).toString('base64'));
}

function sendSubscriptionPanel(req, res, subId) {
  const externalHost = externalHostFor(req);
  const health = getAllHealth();
  // Same mode filtering as the raw feed above -- a disabled mode has
  // no card here either, not just no link in the raw feed.
  const enabledRows = inbounds.listInbounds().filter((row) => isRowEnabled(row));
  const orderedRows = orderInbounds(enabledRows);
  const alpnValues = getEnabledAlpnValues();
  const fingerprints = getEnabledFingerprints();
  const endpoints = orderedRows.map((row) => {
    const links = buildLinksForInbound({ inbound: row, externalHost, alpnValues, fingerprints });
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

  // Days-left / usage-left display (src/subscriptionLimits.js). Both
  // are null (rendered as "Unlimited") unless the admin has set a
  // limit -- see that module's header for the default-unlimited
  // rationale.
  const usageSummary = getUsageSummary(inbounds.getTotalTrafficBytes());

  res.render('subscription', {
    loggedIn: false,
    subId,
    subLink: `${req.protocol}://${req.get('host')}/sub/${subId}`,
    location: `${regionFlag()} ${regionName()}`.trim(),
    endpoints,
    activeCount,
    totalCount: endpoints.length,
    systemStatus,
    daysLeftText: usageSummary.unlimitedDays ? 'Unlimited' : `${usageSummary.daysLeft} Days`,
    usageLeftText: usageSummary.unlimitedUsage ? 'Unlimited' : formatBytes(usageSummary.usageLeftBytes),
    explainField,
    qrIconSvg: QR_ICON_SVG,
  });
}

app.get('/sub/:subId', (req, res) => {
  const subId = req.params.subId;
  if (subId !== inbounds.getOrCreateGlobalSubscriptionId()) {
    return res.status(404).send('Not found');
  }

  if (isBrowserRequest(req)) {
    return sendSubscriptionPanel(req, res, subId);
  }
  sendRawSubscription(req, res);
});

// Explicit-raw alias, kept for anyone who already saved this exact
// URL from before the panel/raw links were merged into one.
app.get('/sub/:subId/raw', (req, res) => {
  if (req.params.subId !== inbounds.getOrCreateGlobalSubscriptionId()) {
    return res.status(404).send('Not found');
  }
  sendRawSubscription(req, res);
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

// REALITY needs its own separately-exposed Railway port (can't share
// 443 with Railway's edge TLS -- see xray/config.js's header), which
// Railway assigns at TCP-Proxy-attach time and doesn't expose to the
// app. This is the one setting that's genuinely admin-entered rather
// than auto-detected -- everything else about REALITY (keypair, short
// ID, camouflage target) is generated automatically (see
// inbounds.js's ensureRealityInbound()). Doesn't restart any core --
// see setRealityExternalAddress's own header.
app.post('/settings/reality', requireAuth, requireCsrf, (req, res) => {
  inbounds.setRealityExternalAddress(req.body.reality_address);
  res.redirect('/');
});

app.get('/', requireAuth, (req, res) => {
  const externalHost = externalHostFor(req);
  const health = getAllHealth();
  const modeState = getModeState();
  const rows = orderInbounds(inbounds.listInbounds()).map((row) => ({
    ...row,
    label: labelForInbound(row),
    health: health[row.id] || { status: 'unknown' },
    // Whether this row's mode is currently enabled (src/modes.js) --
    // used below to compute the active/total endpoint summary.
    enabled: isRowEnabled(row, modeState),
  }));
  const subLink = `${req.protocol}://${req.get('host')}/sub/${inbounds.getOrCreateGlobalSubscriptionId()}`;
  // Same active/total/status computation as GET /sub/:subId, so the
  // admin dashboard's summary card matches what a client sees on the
  // public Subscription Panel (vision rule 20: lead with a simple
  // status/count summary, push technical detail into an Advanced
  // section). Only enabled rows count -- a disabled mode shouldn't
  // drag the summary into "degraded".
  const enabledRows = rows.filter((r) => r.enabled);
  const activeCount = enabledRows.filter((r) => r.health.status === 'healthy' || r.health.status === 'degraded').length;
  const totalCount = enabledRows.length;
  const systemStatus = totalCount === 0 ? 'unavailable' : activeCount < totalCount ? 'degraded' : 'healthy';

  // Time/usage limits (src/subscriptionLimits.js): `limits` (raw
  // admin-set values, or '' for unlimited) pre-fills the settings
  // form below; `usageSummary` is the same days-left/usage-left the
  // Subscription Web Panel shows, for the admin's own visibility.
  const limits = getLimits();
  const usageSummary = getUsageSummary(inbounds.getTotalTrafficBytes());

  // Persistent-storage warning: neither DATA_DIR nor Railway's own
  // RAILWAY_VOLUME_MOUNT_PATH (auto-injected once a Volume is
  // attached -- see src/db.js) being set means the app fell back to a
  // path inside the container's own ephemeral filesystem, which
  // Railway wipes on every redeploy. We can't verify a Volume is
  // actually attached from inside the app beyond checking for that
  // env var, but its absence reliably means persistent storage was
  // never configured at all (see README.md's Volume step).
  const dataDirWarning = !process.env.DATA_DIR && !process.env.RAILWAY_VOLUME_MOUNT_PATH;

  // REALITY setup info (src/inbounds.js's ensureRealityInbound()):
  // the row always exists once the panel has booted at least once,
  // so this should never be null in practice, but the dashboard view
  // guards for it anyway rather than assuming.
  const realityRow = rows.find((r) => r.transport === 'reality');
  const realityInfo = realityRow
    ? {
        internalPort: internalPortForRow(realityRow),
        publicKey: realityRow.reality_public_key,
        shortId: realityRow.reality_short_id,
        dest: realityRow.reality_dest,
        externalAddress: realityRow.reality_external_address || '',
        enabled: realityRow.enabled,
      }
    : null;

  res.render('dashboard', {
    loggedIn: true,
    csrfToken: getOrCreateCsrfToken(req),
    inbounds: rows,
    externalHost,
    subLink,
    activeCount,
    totalCount,
    systemStatus,
    qrIconSvg: QR_ICON_SVG,
    formatBytes,
    modeDimensions: MODE_DIMENSIONS,
    modeState,
    labelForMode,
    modesError: req.query.modesError ? req.query.modesError.split(',') : null,
    limitDays: limits.days === null ? '' : limits.days,
    limitUsageGB: limits.usageGB === null ? '' : limits.usageGB,
    daysLeftText: usageSummary.unlimitedDays ? 'Unlimited' : `${usageSummary.daysLeft} Days`,
    usageLeftText: usageSummary.unlimitedUsage ? 'Unlimited' : formatBytes(usageSummary.usageLeftBytes),
    dataDirWarning,
    realityInfo,
  });
});

// Combined mode toggles + time/usage limits, saved together from one
// "Apply Changes" button (user request -- previously two separate
// forms/routes). Mode enable/disable is a user-requested, explicit
// exception to product-vision.md rules 7/20 (see docs/how-program-
// work.md's Change Log and the note added to product-vision.md
// itself). Cores are only restarted if the mode selection actually
// changed -- saving just a limits change shouldn't disrupt existing
// connections. Order matters when a restart is needed: the new state
// is persisted and every core is fully reloaded against it BEFORE
// this handler responds, so the redirect the admin's browser follows
// always lands on a dashboard that already reflects the change -- no
// window where the page shows stale core/health state.
app.post('/settings/advanced', requireAuth, requireCsrf, async (req, res) => {
  const newState = {};
  for (const [dimension, values] of Object.entries(MODE_DIMENSIONS)) {
    newState[dimension] = {};
    for (const value of values) {
      // Checkboxes only appear in req.body when checked.
      newState[dimension][value] = req.body[`${dimension}_${value}`] === 'on';
    }
  }

  // Reject a submission that would leave any dimension with zero
  // enabled options (e.g. every Protocol value turned off) -- the panel
  // must always have at least one option to generate/serve per
  // dimension. Nothing is persisted (modes OR limits) and no core is
  // restarted in this case; the admin's browser lands back on the
  // dashboard with an error banner instead.
  const invalidDimensions = emptyDimensions(newState);
  if (invalidDimensions.length > 0) {
    return res.redirect(`/?modesError=${invalidDimensions.join(',')}`);
  }

  const modesChanged = JSON.stringify(getModeState()) !== JSON.stringify(newState);

  setModeState(newState);
  setLimits({ days: req.body.days, usageGB: req.body.usage_gb });

  if (modesChanged) {
    await inbounds.reloadCores(); // only restart cores when a mode actually changed
  }

  res.redirect('/');
});

// The actual publicly-listening socket. Every accepted connection
// goes to handleConnection() first (see src/xray/proxy.js), which
// sniffs for `raw`-transport camouflage traffic at the TCP level and
// hands anything else to `server` unchanged.
const tcpServer = net.createServer(handleConnection);

tcpServer.listen(PORT, HOST, () => {
  console.log(`SOLO Panel listening on http://${HOST}:${PORT}`);
});

// Remove any leftover inbound row from a core that no longer exists
// in the codebase (e.g. sing-box, removed 2026-08-29) before seeding
// -- see pruneOrphanedCoreRows()'s own header for why this is needed.
inbounds.pruneOrphanedCoreRows();
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
