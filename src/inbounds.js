// Data-access layer for inbounds, plus a helper to reload xray-core
// when data changes. Routes go through this module, not `db` directly.
// No admin-facing CRUD -- ensureGeneratedInbounds() auto-seeds one
// inbound per supported (protocol x transport) combo.
'use strict';

const crypto = require('crypto');
const { db, getConfigValue, setConfigValue } = require('./db');
const { getCore, listCores } = require('./cores');
const { generatePath, PROTOCOLS, TRANSPORTS } = require('./utils');
const { getModeState, isRowEnabled } = require('./modes');

// Every (core x protocol x transport) combo this panel generates.
// Credentials are shared per protocol across transports. Order here
// is also seeding order, so it determines each row's internal port
// (see xray/config.js). protocols/transports share a single source
// of truth with modes.js's MODE_DIMENSIONS (see utils.js's
// PROTOCOLS/TRANSPORTS).
const CORE_COMBOS = {
  xray: {
    protocols: PROTOCOLS,
    transports: TRANSPORTS,
  },
};

function listInbounds() {
  return db.prepare('SELECT * FROM inbounds ORDER BY id').all();
}

function getInbound(id) {
  return db.prepare('SELECT * FROM inbounds WHERE id = ?').get(id);
}

// Total uplink+downlink bytes across every inbound row -- "how much
// this subscription has used" (see subscriptionLimits.js).
function getTotalTrafficBytes() {
  const row = db.prepare('SELECT COALESCE(SUM(up_bytes + down_bytes), 0) AS total FROM inbounds').get();
  return row.total;
}

// Upload/download bytes summed separately across every inbound.
// getTotalTrafficBytes() above combines both directions into one
// number for the days/usage-left math; the Subscription-Userinfo
// response header (server.js) needs them apart.
function getTrafficBreakdown() {
  return db.prepare('SELECT COALESCE(SUM(up_bytes), 0) AS upload, COALESCE(SUM(down_bytes), 0) AS download FROM inbounds').get();
}

// Delete `inbounds` rows whose `core` isn't currently registered
// (leftovers from a removed core). Safe to run every boot.
function pruneOrphanedCoreRows() {
  const validCores = listCores().map((core) => core.name);
  if (validCores.length === 0) return; // never wipe everything if cores/index.js is empty
  const placeholders = validCores.map(() => '?').join(',');
  db.prepare(`DELETE FROM inbounds WHERE core NOT IN (${placeholders})`).run(...validCores);
}

// Idempotently seed one row per (core x protocol x transport) combo.
// Credentials are shared per protocol. Only inserts combos that are
// actually missing -- checked individually, not just by comparing
// counts, so a partial seed (or a future PROTOCOLS/TRANSPORTS change)
// tops up just the missing rows instead of duplicating existing ones.
function ensureGeneratedInbounds() {
  const existingRows = db.prepare('SELECT core, protocol, transport, client_uuid, trojan_password FROM inbounds').all();
  const existingCombos = new Set(existingRows.map((r) => `${r.core}:${r.protocol}:${r.transport}`));

  // Reuse an existing row's credentials for its protocol (any
  // transport) so a partial top-up shares the same client identity as
  // that protocol's other rows, instead of minting a new one.
  const credentialsByProtocol = {};
  for (const row of existingRows) {
    if (!credentialsByProtocol[row.protocol]) {
      credentialsByProtocol[row.protocol] = { client_uuid: row.client_uuid, trojan_password: row.trojan_password };
    }
  }

  const insert = db.prepare(
    `INSERT INTO inbounds (
      core, protocol, transport, path, client_uuid, trojan_password,
      subscription_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const insertAll = db.transaction(() => {
    for (const [core, combo] of Object.entries(CORE_COMBOS)) {
      for (const protocol of combo.protocols) {
        if (!credentialsByProtocol[protocol]) {
          credentialsByProtocol[protocol] = protocol === 'vless'
            ? { client_uuid: crypto.randomUUID(), trojan_password: null }
            : { client_uuid: null, trojan_password: crypto.randomBytes(12).toString('hex') };
        }
        const creds = credentialsByProtocol[protocol];
        for (const transport of combo.transports) {
          const key = `${core}:${protocol}:${transport}`;
          if (existingCombos.has(key)) continue; // already seeded -- never duplicate
          insert.run(core, protocol, transport, generatePath(), creds.client_uuid, creds.trojan_password, crypto.randomBytes(16).toString('hex'));
          existingCombos.add(key); // guard against dupes within this same run too
        }
      }
    }
  });
  insertAll();

  // REALITY and raw were removed entirely -- one-time cleanup of any
  // leftover rows from before those removals.
  db.prepare("DELETE FROM inbounds WHERE transport IN ('reality', 'raw')").run();
}

// Unguessable token for the single combined subscription URL
// (GET /sub/:subId in server.js). Generated once, persisted.
function getOrCreateGlobalSubscriptionId() {
  const existing = getConfigValue('global_subscription_id');
  if (existing) return existing;

  const id = crypto.randomBytes(16).toString('hex');
  setConfigValue('global_subscription_id', id);
  return id;
}

// Add uplink/downlink byte deltas onto an inbound's running totals.
function addClientTraffic(inboundId, uplinkDelta, downlinkDelta) {
  db.prepare(
    'UPDATE inbounds SET up_bytes = up_bytes + ?, down_bytes = down_bytes + ? WHERE id = ?'
  ).run(uplinkDelta, downlinkDelta, inboundId);
}

// Zero out every inbound's traffic counters -- admin-triggered "reset
// usage" action (dashboard's Usage limit icon). Only the running
// totals are cleared; the admin's usage-limit-GB setting and the
// days-left countdown (subscriptionLimits.js) are untouched.
function resetUsage() {
  db.prepare('UPDATE inbounds SET up_bytes = 0, down_bytes = 0').run();
}

// Rebuild one core's config from current DB state and (re)start it.
// Only rows whose mode is enabled (modes.js) are served.
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

// Reload every registered core, each with only its own rows.
async function reloadCores() {
  for (const core of listCores()) {
    await reloadCore(core.name);
  }
}

module.exports = {
  listInbounds,
  getInbound,
  getTotalTrafficBytes,
  getTrafficBreakdown,
  pruneOrphanedCoreRows,
  ensureGeneratedInbounds,
  getOrCreateGlobalSubscriptionId,
  addClientTraffic,
  resetUsage,
  reloadCore,
  reloadCores,
};
