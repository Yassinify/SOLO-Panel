// Entry point for the SOLO Panel web server.
//
// Railway requirement: the app must listen on 0.0.0.0:$PORT.
// See docs/how-program-work.md for the networking rationale.
'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const { getOrCreateSessionSecret } = require('./db'); // also initializes SQLite DB and tables on startup
const { seedAdminFromEnv, verifyLogin, requireAuth, listAdmins, createAdmin, deleteAdmin, countAdmins } = require('./auth');
const inbounds = require('./inbounds');
const manager = require('./xray/manager');
const { buildClientLink } = require('./xray/links');
const { attachWsProxy } = require('./xray/proxy');
const { internalPortForInbound } = require('./xray/config');
const statsPoller = require('./xray/statsPoller');
const { formatBytes } = require('./utils');

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
// client app's "subscribe" URL field. Returns the client's share link
// base64-encoded (the standard subscription format most VPN client
// apps expect), or 404 if the token doesn't match any client.
app.get('/sub/:subId', (req, res) => {
  const client = inbounds.getClientBySubscriptionId(req.params.subId);
  if (!client) return res.status(404).send('Not found');

  const inbound = inbounds.getInbound(client.inbound_id);
  if (!inbound) return res.status(404).send('Not found');

  const publicHost = req.get('host');
  const link = buildClientLink({ inbound, client, publicHost });
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
  const rows = inbounds.listInbounds().map((row) => {
    const clients = inbounds.listClients(row.id);
    const totalBytes = clients.reduce((sum, c) => sum + c.up_bytes + c.down_bytes, 0);
    return { ...row, clientCount: clients.length, totalTraffic: formatBytes(totalBytes) };
  });
  res.render('dashboard', {
    username: req.session.username,
    inbounds: rows,
    xrayRunning: manager.isRunning(),
  });
});

app.get('/inbounds/new', requireAuth, (req, res) => {
  res.render('inbound_new', {
    username: req.session.username,
    error: null,
    randomPath: crypto.randomBytes(6).toString('hex'),
  });
});

app.post('/inbounds', requireAuth, async (req, res) => {
  const { remark, protocol, listenPath, transport } = req.body;
  const isTcp = transport === 'tcp';

  if (!remark || !protocol) {
    return res.render('inbound_new', {
      username: req.session.username,
      error: 'Remark and protocol are required.',
      randomPath: crypto.randomBytes(6).toString('hex'),
    });
  }
  if (!isTcp && (!listenPath || !listenPath.startsWith('/'))) {
    return res.render('inbound_new', {
      username: req.session.username,
      error: 'A WebSocket path starting with "/" is required.',
      randomPath: crypto.randomBytes(6).toString('hex'),
    });
  }
  // Two ws inbounds sharing a path would silently collide in
  // xray/proxy.js's routing (`.find()` picks whichever was created
  // first), sending the second inbound's clients to the wrong
  // xray-core inbound. Reject the duplicate up front instead.
  if (!isTcp && inbounds.listInbounds().some((row) => row.listen_path === listenPath)) {
    return res.render('inbound_new', {
      username: req.session.username,
      error: `Path "${listenPath}" is already used by another inbound. Choose a different path.`,
      randomPath: crypto.randomBytes(6).toString('hex'),
    });
  }

  // Railway terminates TLS at its edge for the HTTP domain, so a 'ws'
  // inbound's xray-core side sees plain WebSocket traffic (see
  // docs/how-program-work.md). A 'tcp' inbound is raw TCP reached via
  // a manually-configured Railway TCP Proxy — no Railway-side TLS
  // termination there, so it is plaintext at the transport level.
  const streamSettings = isTcp
    ? { network: 'tcp', security: 'none' }
    : { network: 'ws', security: 'none', wsSettings: { path: listenPath } };

  inbounds.createInbound({
    remark,
    protocol,
    listenPath: isTcp ? null : listenPath,
    streamSettings,
    transport: isTcp ? 'tcp' : 'ws',
  });
  await inbounds.reloadXray();
  res.redirect('/');
});

app.post('/inbounds/:id/toggle', requireAuth, async (req, res) => {
  const inbound = inbounds.getInbound(req.params.id);
  if (inbound) {
    inbounds.setInboundEnabled(inbound.id, !inbound.enabled);
    await inbounds.reloadXray();
  }
  res.redirect('/');
});

app.post('/inbounds/:id/delete', requireAuth, async (req, res) => {
  inbounds.deleteInbound(req.params.id);
  await inbounds.reloadXray();
  res.redirect('/');
});

app.get('/inbounds/:id', requireAuth, (req, res) => {
  const inbound = inbounds.getInbound(req.params.id);
  if (!inbound) return res.redirect('/');

  const clients = inbounds.listClients(inbound.id);
  const publicHost = req.get('host');
  const links = {};
  const subLinks = {};
  clients.forEach((client) => {
    links[client.id] = buildClientLink({ inbound, client, publicHost });
    subLinks[client.id] = `${req.protocol}://${publicHost}/sub/${client.subscription_id}`;
  });

  res.render('inbound_detail', {
    username: req.session.username,
    inbound,
    clients,
    links,
    subLinks,
    formatBytes,
    internalPort: internalPortForInbound(inbound.id),
  });
});

// Saves the Railway-assigned external host/port for a 'tcp' transport
// inbound, once the admin has manually set up a Railway TCP Proxy
// pointing at this inbound's internal port (shown on the detail page).
app.post('/inbounds/:id/external', requireAuth, (req, res) => {
  const { externalHost, externalPort } = req.body;
  if (externalHost && externalPort) {
    inbounds.setInboundExternalAddress(req.params.id, externalHost, Number(externalPort));
  }
  res.redirect(`/inbounds/${req.params.id}`);
});

app.post('/inbounds/:id/clients', requireAuth, async (req, res) => {
  const { email } = req.body;
  if (email) {
    inbounds.addClient(req.params.id, { email });
    await inbounds.reloadXray();
  }
  res.redirect(`/inbounds/${req.params.id}`);
});

app.post('/inbounds/:id/clients/:clientId/toggle', requireAuth, async (req, res) => {
  const client = inbounds
    .listClients(req.params.id)
    .find((c) => String(c.id) === req.params.clientId);
  if (client) {
    inbounds.setClientEnabled(client.id, !client.enabled);
    await inbounds.reloadXray();
  }
  res.redirect(`/inbounds/${req.params.id}`);
});

app.post('/inbounds/:id/clients/:clientId/delete', requireAuth, async (req, res) => {
  inbounds.deleteClient(req.params.clientId);
  await inbounds.reloadXray();
  res.redirect(`/inbounds/${req.params.id}`);
});

app.get('/admins', requireAuth, (req, res) => {
  res.render('admins', {
    username: req.session.username,
    admins: listAdmins(),
    currentAdminId: req.session.adminId,
    error: null,
  });
});

app.post('/admins', requireAuth, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.render('admins', {
      username: req.session.username,
      admins: listAdmins(),
      currentAdminId: req.session.adminId,
      error: 'Username and password are required.',
    });
  }

  try {
    createAdmin(username, password);
  } catch (err) {
    return res.render('admins', {
      username: req.session.username,
      admins: listAdmins(),
      currentAdminId: req.session.adminId,
      error: 'That username is already taken.',
    });
  }
  res.redirect('/admins');
});

app.post('/admins/:id/delete', requireAuth, (req, res) => {
  const targetId = Number(req.params.id);

  if (targetId === req.session.adminId) {
    return res.render('admins', {
      username: req.session.username,
      admins: listAdmins(),
      currentAdminId: req.session.adminId,
      error: "You can't delete your own account while logged in as it.",
    });
  }

  if (countAdmins() <= 1) {
    return res.render('admins', {
      username: req.session.username,
      admins: listAdmins(),
      currentAdminId: req.session.adminId,
      error: 'At least one admin account must remain.',
    });
  }

  deleteAdmin(targetId);
  res.redirect('/admins');
});

const server = app.listen(PORT, HOST, () => {
  console.log(`SOLO Panel listening on http://${HOST}:${PORT}`);
});

// Proxies WebSocket upgrade requests whose path matches an enabled
// inbound's listen_path to that inbound's internal xray-core port,
// so panel UI and proxy traffic share Railway's one public port.
attachWsProxy(server);

// Start xray-core with whatever inbounds are already in the DB.
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
