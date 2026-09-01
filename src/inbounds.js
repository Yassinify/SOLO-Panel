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

// Delete `inbounds` rows whose `core` isn't currently registered
// (leftovers from a removed core). Safe to run every boot.
function pruneOrphanedCoreRows() {
  const validCores = listCores().map((core) => core.name);
  if (validCores.length === 0) return; // never wipe everything if cores/index.js is empty
  const placeholders = validCores.map(() => '?').join(',');
  db.prepare(`DELETE FROM inbounds WHERE core NOT IN (${placeholders})`).run(...validCores);
}

// Idempotently seed one row per (core x protocol x transport) combo.
// Credentials are shared per protocol. No-op once all rows exist.
function ensureGeneratedInbounds() {
  const expectedCount = Object.values(CORE_COMBOS)
    .reduce((sum, combo) => sum + combo.protocols.length * combo.transports.length, 0);
  const existingCount = db.prepare('SELECT COUNT(*) AS n FROM inbounds').get().n;

  if (existingCount < expectedCount) {
    const credentialsByProtocol = {
      vless: { client_uuid: crypto.randomUUID() },
      trojan: { trojan_password: crypto.randomBytes(12).toString('hex') },
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
              generatePath(),
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
  pruneOrphanedCoreRows,
  ensureGeneratedInbounds,
  getOrCreateGlobalSubscriptionId,
  addClientTraffic,
  reloadCore,
  reloadCores,
};
