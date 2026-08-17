// Data-access layer for inbounds (each inbound bundles its own single
// VLESS+REALITY client), plus a helper to reload xray-core whenever
// the underlying data changes. Routes should go through this module
// rather than touching `db` directly, so the "rebuild config + restart
// xray" step never gets forgotten.
//
// There is no admin-facing inbound CRUD anymore. Instead
// `ensureGeneratedInbounds()` auto-seeds one inbound per supported
// (transport x ALPN) combination — see docs/how-program-work.md for
// why these are the only combinations Railway + REALITY support.
'use strict';

const crypto = require('crypto');
const { db } = require('./db');
const manager = require('./xray/manager');
const { buildXrayConfig } = require('./xray/config');
const {
  generateRealityKeyPair,
  generateRealityShortId,
  generateGrpcServiceName,
  generateXhttpPath,
} = require('./utils');

// Site to borrow the TLS identity of for REALITY's handshake. A
// well-known, reliably-available TLS 1.3 + h2 site works for any
// inbound; kept fixed so inbound creation never needs manual input.
const REALITY_DEST_HOST = 'www.microsoft.com';
const REALITY_DEST = `${REALITY_DEST_HOST}:443`;

// The only transports valid under `security: reality` in Xray-core
// (WS/H2/QUIC are not) x the ALPN variants worth offering as separate
// fallback entry points. Every combination gets its own inbound, own
// internal port, and its own Railway TCP Proxy for the admin to set
// up. Order here is also seeding order, so it determines inbound ids
// (and therefore internal ports, see xray/config.js).
const TRANSPORTS = ['tcp', 'grpc', 'xhttp'];
const ALPN_VARIANTS = ['h2', 'http/1.1', 'h2,http/1.1'];

function listInbounds() {
  return db.prepare('SELECT * FROM inbounds ORDER BY id').all();
}

function getInbound(id) {
  return db.prepare('SELECT * FROM inbounds WHERE id = ?').get(id);
}

/**
 * Idempotently seed one inbound row per (transport x ALPN) combo, all
 * sharing a single REALITY keypair and client UUID (generated once,
 * on first ever call) so every generated config is just a different
 * front door to the same account — not a separate identity. Safe to
 * call on every boot: does nothing once the 9 rows already exist.
 */
function ensureGeneratedInbounds() {
  const existingCount = db.prepare('SELECT COUNT(*) AS n FROM inbounds').get().n;
  const expectedCount = TRANSPORTS.length * ALPN_VARIANTS.length;
  if (existingCount >= expectedCount) return;

  const { privateKey, publicKey } = generateRealityKeyPair();
  const sharedShortId = generateRealityShortId();
  const sharedClientUuid = crypto.randomUUID();

  const insert = db.prepare(
    `INSERT INTO inbounds (
      transport, fingerprint, alpn, grpc_service_name, xhttp_path,
      reality_dest, reality_server_name, reality_private_key,
      reality_public_key, reality_short_id, client_uuid, subscription_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const insertAll = db.transaction(() => {
    for (const transport of TRANSPORTS) {
      for (const alpn of ALPN_VARIANTS) {
        insert.run(
          transport,
          'chrome',
          alpn,
          transport === 'grpc' ? generateGrpcServiceName() : null,
          transport === 'xhttp' ? generateXhttpPath() : null,
          REALITY_DEST,
          REALITY_DEST_HOST,
          privateKey,
          publicKey,
          sharedShortId,
          sharedClientUuid,
          crypto.randomBytes(16).toString('hex')
        );
      }
    }
  });
  insertAll();
}

/**
 * Save the Railway-assigned external host/port for this inbound's
 * Railway TCP Proxy. Set by the admin after manually configuring the
 * proxy in the Railway dashboard (see docs/how-program-work.md). No
 * xray reload needed — this only affects the client-facing share
 * link, not xray's own config.
 */
function setInboundExternalAddress(id, externalHost, externalPort) {
  db.prepare('UPDATE inbounds SET external_host = ?, external_port = ? WHERE id = ?').run(
    externalHost,
    externalPort,
    id
  );
}

function getInboundBySubscriptionId(subId) {
  return db.prepare('SELECT * FROM inbounds WHERE subscription_id = ?').get(subId);
}

/**
 * Add uplink/downlink byte deltas (from one Stats API poll) onto an
 * inbound's running totals. Called from the polling loop in server.js
 * with values from xray/stats.js's toClientTraffic(); safe to call
 * with an inboundId that no longer exists (no-op, 0 rows affected).
 */
function addClientTraffic(inboundId, uplinkDelta, downlinkDelta) {
  db.prepare(
    'UPDATE inbounds SET up_bytes = up_bytes + ?, down_bytes = down_bytes + ? WHERE id = ?'
  ).run(uplinkDelta, downlinkDelta, inboundId);
}

/**
 * Rebuild the Xray config from current DB state and (re)start
 * xray-core with it. Call this after any DB change affecting
 * inbounds (currently just external-address updates, which don't
 * actually need a reload, but this stays the single choke point in
 * case that changes). All generated inbounds are always active — no
 * per-inbound enabled flag anymore.
 */
async function reloadXray() {
  const config = buildXrayConfig(listInbounds());

  if (manager.isRunning()) {
    await manager.restart(config);
  } else {
    manager.start(config);
  }
}

module.exports = {
  listInbounds,
  getInbound,
  ensureGeneratedInbounds,
  setInboundExternalAddress,
  getInboundBySubscriptionId,
  addClientTraffic,
  reloadXray,
};
