// Data-access layer for inbounds, plus a helper to reload xray-core
// whenever the underlying data changes. Routes should go through this
// module rather than touching `db` directly, so the "rebuild config +
// restart xray" step never gets forgotten.
//
// There is no admin-facing inbound CRUD. Instead
// `ensureGeneratedInbounds()` auto-seeds one inbound per supported
// (protocol x transport) combination, all running behind Railway's
// own edge TLS on its single public port — see docs/how-program-work.md.
'use strict';

const crypto = require('crypto');
const { db, getConfigValue, setConfigValue } = require('./db');
const manager = require('./xray/manager');
const { buildXrayConfig } = require('./xray/config');
const { generatePath, generateSsPassword, generateRawHttpPath } = require('./utils');

// Every protocol x transport combination that works over Railway's
// single HTTPS edge port. `raw` is TCP with HTTP-header obfuscation
// (looks like a plain HTTP request on the wire, so it demuxes by path
// the same way xhttp does — see xray/proxy.js); gRPC / REALITY are
// still excluded, they need their own port (see docs/how-program-work.md).
// Order here is also seeding order, so it determines inbound ids (and
// therefore internal ports, see xray/config.js).
const PROTOCOLS = ['vless', 'vmess', 'trojan', 'shadowsocks'];
const TRANSPORTS = ['ws', 'xhttp', 'httpupgrade', 'raw'];

// Fixed AEAD method for every generated Shadowsocks inbound.
const SS_METHOD = 'chacha20-ietf-poly1305';

function listInbounds() {
  return db.prepare('SELECT * FROM inbounds ORDER BY id').all();
}

function getInbound(id) {
  return db.prepare('SELECT * FROM inbounds WHERE id = ?').get(id);
}

/**
 * Idempotently seed one inbound row per (protocol x transport) combo.
 * Credentials are generated once per protocol (not per row) and
 * reused across that protocol's 3 transport rows, so every generated
 * config for a given protocol is just a different front door to the
 * same account — not a separate identity. Safe to call on every
 * boot: does nothing once all rows already exist.
 */
function ensureGeneratedInbounds() {
  const existingCount = db.prepare('SELECT COUNT(*) AS n FROM inbounds').get().n;
  const expectedCount = PROTOCOLS.length * TRANSPORTS.length;
  if (existingCount >= expectedCount) return;

  const credentialsByProtocol = {
    vless: { client_uuid: crypto.randomUUID() },
    vmess: { client_uuid: crypto.randomUUID() },
    trojan: { trojan_password: crypto.randomBytes(12).toString('hex') },
    shadowsocks: { ss_method: SS_METHOD, ss_password: generateSsPassword() },
  };

  const insert = db.prepare(
    `INSERT INTO inbounds (
      protocol, transport, path, client_uuid, trojan_password,
      ss_method, ss_password, subscription_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const insertAll = db.transaction(() => {
    for (const protocol of PROTOCOLS) {
      const creds = credentialsByProtocol[protocol];
      for (const transport of TRANSPORTS) {
        insert.run(
          protocol,
          transport,
          transport === 'raw' ? generateRawHttpPath() : generatePath(),
          creds.client_uuid || null,
          creds.trojan_password || null,
          creds.ss_method || null,
          creds.ss_password || null,
          crypto.randomBytes(16).toString('hex')
        );
      }
    }
  });
  insertAll();
}

/**
 * Unguessable token for the single combined subscription URL (see
 * `GET /sub/:subId` in server.js), which returns every configured
 * inbound's client link at once. Generated once and persisted, same
 * pattern as `getOrCreateSessionSecret` in db.js.
 */
function getOrCreateGlobalSubscriptionId() {
  const existing = getConfigValue('global_subscription_id');
  if (existing) return existing;

  const id = crypto.randomBytes(16).toString('hex');
  setConfigValue('global_subscription_id', id);
  return id;
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
 * xray-core with it. Called once on boot after seeding. All generated
 * inbounds are always active — no per-inbound enabled flag.
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
  getOrCreateGlobalSubscriptionId,
  addClientTraffic,
  reloadXray,
};
