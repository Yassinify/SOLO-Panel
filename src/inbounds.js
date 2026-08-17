// Data-access layer for inbounds/clients, plus a helper to reload
// xray-core whenever the underlying data changes. Routes should go
// through this module rather than touching `db` directly, so the
// "rebuild config + restart xray" step never gets forgotten.
'use strict';

const crypto = require('crypto');
const { db } = require('./db');
const manager = require('./xray/manager');
const { buildXrayConfig } = require('./xray/config');

function listInbounds() {
  return db.prepare('SELECT * FROM inbounds ORDER BY id').all();
}

function getInbound(id) {
  return db.prepare('SELECT * FROM inbounds WHERE id = ?').get(id);
}

function listClients(inboundId) {
  return db
    .prepare('SELECT * FROM inbound_clients WHERE inbound_id = ? ORDER BY id')
    .all(inboundId);
}

function createInbound({ remark, protocol, listenPath, streamSettings, transport }) {
  const result = db
    .prepare(
      'INSERT INTO inbounds (remark, protocol, listen_path, config_json, transport) VALUES (?, ?, ?, ?, ?)'
    )
    .run(remark, protocol, listenPath || null, JSON.stringify(streamSettings), transport || 'ws');
  return result.lastInsertRowid;
}

/**
 * Save the Railway-assigned external host/port for a 'tcp' transport
 * inbound. Set by the admin after manually configuring a Railway TCP
 * Proxy pointing at this inbound's internal port (see
 * docs/how-program-work.md). No xray reload needed — this only
 * affects the client-facing share link, not xray's own config.
 */
function setInboundExternalAddress(id, externalHost, externalPort) {
  db.prepare('UPDATE inbounds SET external_host = ?, external_port = ? WHERE id = ?').run(
    externalHost,
    externalPort,
    id
  );
}

function setInboundEnabled(id, enabled) {
  db.prepare('UPDATE inbounds SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}

function deleteInbound(id) {
  db.prepare('DELETE FROM inbounds WHERE id = ?').run(id);
}

function addClient(inboundId, { email, uuid }) {
  const clientUuid = uuid || crypto.randomUUID();
  const subscriptionId = crypto.randomBytes(16).toString('hex');
  const result = db
    .prepare(
      'INSERT INTO inbound_clients (inbound_id, email, client_uuid, subscription_id) VALUES (?, ?, ?, ?)'
    )
    .run(inboundId, email, clientUuid, subscriptionId);
  return result.lastInsertRowid;
}

function getClientBySubscriptionId(subId) {
  return db
    .prepare('SELECT * FROM inbound_clients WHERE subscription_id = ?')
    .get(subId);
}

function setClientEnabled(id, enabled) {
  db.prepare('UPDATE inbound_clients SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}

function deleteClient(id) {
  db.prepare('DELETE FROM inbound_clients WHERE id = ?').run(id);
}

/**
 * Add uplink/downlink byte deltas (from one Stats API poll) onto a
 * client's running totals. Called from the polling loop in server.js
 * with values from xray/stats.js's toClientTraffic(); safe to call
 * with a clientId that no longer exists (no-op, 0 rows affected).
 */
function addClientTraffic(clientId, uplinkDelta, downlinkDelta) {
  db.prepare(
    'UPDATE inbound_clients SET up_bytes = up_bytes + ?, down_bytes = down_bytes + ? WHERE id = ?'
  ).run(uplinkDelta, downlinkDelta, clientId);
}

/**
 * Rebuild the Xray config from current DB state and (re)start xray-core
 * with it. Call this after any create/update/delete of inbounds or
 * clients. No-op-safe to call even with zero enabled inbounds (xray
 * will just run with an empty inbound list).
 */
async function reloadXray() {
  const enabledInbounds = listInbounds().filter((row) => row.enabled);
  const clientsByInboundId = new Map(
    enabledInbounds.map((row) => [row.id, listClients(row.id)])
  );
  const config = buildXrayConfig(enabledInbounds, clientsByInboundId);

  if (manager.isRunning()) {
    await manager.restart(config);
  } else {
    manager.start(config);
  }
}

module.exports = {
  listInbounds,
  getInbound,
  listClients,
  createInbound,
  setInboundEnabled,
  setInboundExternalAddress,
  deleteInbound,
  addClient,
  getClientBySubscriptionId,
  setClientEnabled,
  deleteClient,
  addClientTraffic,
  reloadXray,
};
