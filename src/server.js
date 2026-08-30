// Entry point for the SOLO Panel web server. Must listen on 0.0.0.0:$PORT (Railway requirement).
'use strict';

const path = require('path');
const http = require('http');
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
const { formatBytes, QR_ICON_SVG, regionFlag, regionName, currentRegion, explainField } = require('./utils');
const { MODE_DIMENSIONS, getModeState, setModeState, isRowEnabled, emptyDimensions, labelForMode, getEnabledAlpnValues, getEnabledFingerprints, getIpv6Enabled, setIpv6Enabled } = require('./modes');
const { getLimits, setLimits, getUsageSummary } = require('./subscriptionLimits');

// The public host clients connect to.
function externalHostFor(req) {
  return process.env.RAILWAY_PUBLIC_DOMAIN || req.get('host');
}

// Distinguishes a browser from a VPN client app, so one subscription
// URL can serve both. Client apps don't send a Mozilla-style User-Agent.
function isBrowserRequest(req) {
  return /Mozilla/i.test(req.get('user-agent') || '');
}

seedAdminFromEnv();

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.set('view engine', 'ejs');
app.set('views', `${__dirname}/views`);
// Available to every view without passing it explicitly.
app.locals.appVersion = APP_VERSION;
// Railway terminates TLS at its edge; trust the proxy so
// express-session marks cookies secure correctly in production.
app.set('trust proxy', 1);

// Must run before static/session/routes: forwards XHTTP requests to
// the matching inbound's internal core process, bypassing the rest
// of the middleware chain.
const { xhttpMiddleware } = attachProxy(server, inbounds.listInbounds, internalPortForRow);
app.use(xhttpMiddleware);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false }));

// Prefer SESSION_SECRET from env; fall back to a persisted generated
// secret so sessions survive restarts without a shared hardcoded one.
const sessionSecret = process.env.SESSION_SECRET || getOrCreateSessionSecret();
app.use(session({
  store: new SqliteSessionStore(), // persists sessions in SQLite so a redeploy/restart doesn't log the admin out
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  },
}));

// Health check endpoint (used to verify the service is up on Railway).
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Public subscription endpoint. No auth, single URL for everyone --
// content-negotiated by User-Agent (see isBrowserRequest()): a
// browser gets the HTML panel, a VPN client app gets the raw base64
// link feed. `/sub/:subId/raw` below is an explicit-raw alias.
function sendRawSubscription(req, res) {
  // Rows whose mode is currently disabled are left out entirely.
  const enabledRows = inbounds.listInbounds().filter((row) => isRowEnabled(row));
  const links = buildAllClientLinks(orderInbounds(enabledRows), externalHostFor(req), getEnabledAlpnValues(), getEnabledFingerprints(), getIpv6Enabled());

  // Leading informational entry (non-functional, 127.0.0.1:443) so a
  // client app's server list shows days-left/usage-left directly.
  const usageSummary = getUsageSummary(inbounds.getTotalTrafficBytes());
  const usageInfoLink = buildUsageInfoLink(
    `\ud83d\udcc5 ${usageSummary.unlimitedDays ? 'Unlimited' : `${usageSummary.daysLeft} Days`}  \ud83d\udcca ${usageSummary.unlimitedUsage ? 'Unlimited' : `${formatBytes(usageSummary.usageUsedBytes)} / ${usageSummary.usageTotalGB} GB`}`
  );

  res.type('text/plain').send(Buffer.from([usageInfoLink, ...links].join('\n')).toString('base64'));
}

function sendSubscriptionPanel(req, res, subId) {
  const externalHost = externalHostFor(req);
  const health = getAllHealth();
  // Same mode filtering as the raw feed above.
  const enabledRows = inbounds.listInbounds().filter((row) => isRowEnabled(row));
  const orderedRows = orderInbounds(enabledRows);
  const alpnValues = getEnabledAlpnValues();
  const fingerprints = getEnabledFingerprints();
  const ipv6Enabled = getIpv6Enabled();
  const endpoints = orderedRows.map((row) => {
    const links = buildLinksForInbound({ inbound: row, externalHost, alpnValues, fingerprints, ipv6Enabled });
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
  // Overall status: unavailable if nothing is reachable, degraded if
  // some but not all endpoints are, healthy otherwise.
  const systemStatus = activeCount === 0 ? 'unavailable' : activeCount < endpoints.length ? 'degraded' : 'healthy';

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
    usageLeftText: usageSummary.unlimitedUsage ? 'Unlimited' : `${formatBytes(usageSummary.usageUsedBytes)} / ${usageSummary.usageTotalGB} GB`,
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

// Explicit-raw alias, kept for anyone who already saved this exact URL.
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

app.get('/', requireAuth, (req, res) => {
  const externalHost = externalHostFor(req);
  const health = getAllHealth();
  const modeState = getModeState();
  const rows = orderInbounds(inbounds.listInbounds()).map((row) => ({
    ...row,
    label: labelForInbound(row),
    health: health[row.id] || { status: 'unknown' },
    enabled: isRowEnabled(row, modeState),
  }));
  const subLink = `${req.protocol}://${req.get('host')}/sub/${inbounds.getOrCreateGlobalSubscriptionId()}`;
  // Same active/total/status computation as GET /sub/:subId. Only
  // enabled rows count toward the summary.
  const enabledRows = rows.filter((r) => r.enabled);
  const activeCount = enabledRows.filter((r) => r.health.status === 'healthy' || r.health.status === 'degraded').length;
  const totalCount = enabledRows.length;
  const systemStatus = totalCount === 0 ? 'unavailable' : activeCount < totalCount ? 'degraded' : 'healthy';

  const limits = getLimits();
  const usageSummary = getUsageSummary(inbounds.getTotalTrafficBytes());

  // No persistent storage configured (no Volume attached) if neither
  // DATA_DIR nor Railway's own RAILWAY_VOLUME_MOUNT_PATH is set.
  const dataDirWarning = !process.env.DATA_DIR && !process.env.RAILWAY_VOLUME_MOUNT_PATH;

  res.render('dashboard', {
    loggedIn: true,
    csrfToken: getOrCreateCsrfToken(req),
    inbounds: rows,
    externalHost,
    subLink,
    location: currentRegion(),
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
    ipv6Enabled: getIpv6Enabled(),
    daysLeftText: usageSummary.unlimitedDays ? 'Unlimited' : `${usageSummary.daysLeft} Days`,
    usageLeftText: usageSummary.unlimitedUsage ? 'Unlimited' : formatBytes(usageSummary.usageLeftBytes),
    dataDirWarning,
  });
});

// Combined mode toggles + time/usage limits, saved together. Cores
// only restart if the mode selection actually changed. New state is
// persisted and cores reloaded BEFORE responding, so the redirect
// always lands on an up-to-date dashboard.
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
  // enabled options. Nothing is persisted and no core is restarted.
  const invalidDimensions = emptyDimensions(newState);
  if (invalidDimensions.length > 0) {
    return res.redirect(`/?modesError=${invalidDimensions.join(',')}`);
  }

  const modesChanged = JSON.stringify(getModeState()) !== JSON.stringify(newState);

  setModeState(newState);
  setLimits({ days: req.body.days, usageGB: req.body.usage_gb });
  setIpv6Enabled(req.body.ipv6_enabled === 'on');

  if (modesChanged) {
    await inbounds.reloadCores(); // only restart cores when a mode actually changed
  }

  res.redirect('/');
});

server.listen(PORT, HOST, () => {
  console.log(`SOLO Panel listening on http://${HOST}:${PORT}`);
});

// Remove leftover inbound rows from a core that no longer exists,
// then seed the fixed set of auto-generated inbounds (no-op after
// first boot), then start every registered core.
inbounds.pruneOrphanedCoreRows();
inbounds.ensureGeneratedInbounds();
inbounds.reloadCores().catch((err) => {
  console.error('Failed to start cores on boot:', err.message);
});

// Periodically pull per-client traffic counters from every core's Stats API.
statsPoller.start();

// Periodically check every generated endpoint's reachability.
healthMonitor.start();

async function shutdown() {
  console.log('Shutting down: stopping all cores...');
  statsPoller.stop();
  healthMonitor.stop();
  await Promise.all(listCores().map((core) => core.stop()));
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
