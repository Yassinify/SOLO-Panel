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
const { getCore, listCores } = require('./cores');
const { generatePath, generateSsPassword, generateRawHttpPath } = require('./utils');
const { getModeState, isRowEnabled } = require('./modes');

// Every (core x protocol x transport) combination this panel
// generates. `raw`/`xhttp`/shadowsocks are Xray-only (xhttp and raw's
// HTTP-camouflage sniffing aren't things sing-box implements the same
// way; shadowsocks has no ws/httpupgrade transport in sing-box at all
// - see src/singbox/config.js's header). Credentials are generated
// once per protocol (not per core+transport) and reused across every
// row of that protocol, so a given protocol is one account with many
// front doors - xray and sing-box included - not a separate identity
// per core. Order here is also seeding order, so it determines
// inbound ids (and therefore each core's own internal ports - see
// xray/config.js and singbox/config.js, which use different port
// ranges precisely so ids can overlap safely between cores).
const CORE_COMBOS = {
  xray: {
    protocols: ['vless', 'vmess', 'trojan', 'shadowsocks'],
    transports: ['ws', 'xhttp', 'httpupgrade', 'raw'],
  },
  singbox: {
    protocols: ['vless', 'vmess', 'trojan'],
    transports: ['ws', 'httpupgrade'],
  },
};

// Fixed AEAD method for every generated Shadowsocks inbound.
const SS_METHOD = 'chacha20-ietf-poly1305';

function listInbounds() {
  return db.prepare('SELECT * FROM inbounds ORDER BY id').all();
}

function getInbound(id) {
  return db.prepare('SELECT * FROM inbounds WHERE id = ?').get(id);
}

/**
 * Total uplink+downlink bytes across every generated inbound row.
 * Since every row is just a different front door to the same single
 * installation identity (see product-vision.md rule 19 and this
 * file's CORE_COMBOS comment), this sum is "how much data this
 * subscription has used", used by src/subscriptionLimits.js's usage
 * cap display.
 */
function getTotalTrafficBytes() {
  const row = db.prepare('SELECT COALESCE(SUM(up_bytes + down_bytes), 0) AS total FROM inbounds').get();
  return row.total;
}

/**
 * Idempotently seed one inbound row per (core x protocol x transport)
 * combo (see CORE_COMBOS above). Credentials are generated once per
 * protocol and reused across every core/transport row of that
 * protocol. Safe to call on every boot: does nothing once all rows
 * already exist.
 */
function ensureGeneratedInbounds() {
  const expectedCount = Object.values(CORE_COMBOS)
    .reduce((sum, combo) => sum + combo.protocols.length * combo.transports.length, 0);
  const existingCount = db.prepare('SELECT COUNT(*) AS n FROM inbounds').get().n;
  if (existingCount >= expectedCount) return;

  const credentialsByProtocol = {
    vless: { client_uuid: crypto.randomUUID() },
    vmess: { client_uuid: crypto.randomUUID() },
    trojan: { trojan_password: crypto.randomBytes(12).toString('hex') },
    shadowsocks: { ss_method: SS_METHOD, ss_password: generateSsPassword() },
  };

  const insert = db.prepare(
    `INSERT INTO inbounds (
      core, protocol, transport, path, client_uuid, trojan_password,
      ss_method, ss_password, subscription_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const insertAll = db.transaction(() => {
    for (const [core, combo] of Object.entries(CORE_COMBOS)) {
      for (const protocol of combo.protocols) {
        const creds = credentialsByProtocol[protocol];
        for (const transport of combo.transports) {
          insert.run(
            core,
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
 * Rebuild one core's config from current DB state (that core's rows
 * only — see CORE_COMBOS) and (re)start it. Called for every
 * registered core on boot (see reloadCores below), and safe to call
 * for a single core after a future targeted change. Every generated
 * row is served unless its mode (core/protocol/transport) has been
 * explicitly disabled via src/modes.js — a user-requested exception
 * to product-vision.md rules 7/20, see docs/how-program-work.md.
 *
 * Goes through the generic core abstraction (src/cores) instead of
 * a specific core module directly — see docs/product-vision.md rule
 * 6/7.
 */
async function reloadCore(coreName) {
  const core = getCore(coreName);
  const modeState = getModeState();
  const rows = listInbounds().filter(
    (row) => row.core === coreName && isRowEnabled(row, modeState)
  );

  if (core.status() === 'running') {
    await core.restart(rows);
  } else {
    core.start(rows);
  }
}

/**
 * Reload every registered core (see src/cores/index.js), each with
 * only its own rows. This is what boot (and any future "config
 * changed" trigger) should call — never call a specific core's
 * reload directly, or a second core silently never starts (this was
 * a real bug: see docs/how-program-work.md's sing-box wiring entry).
 */
async function reloadCores() {
  for (const core of listCores()) {
    await reloadCore(core.name);
  }
}

module.exports = {
  listInbounds,
  getInbound,
  getTotalTrafficBytes,
  ensureGeneratedInbounds,
  getOrCreateGlobalSubscriptionId,
  addClientTraffic,
  reloadCore,
  reloadCores,
};
