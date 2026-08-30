// Data-access layer for inbounds, plus a helper to reload xray-core
// whenever the underlying data changes. Routes should go through this
// module rather than touching `db` directly, so the "rebuild config +
// restart xray" step never gets forgotten.
//
// There is no admin-facing inbound CRUD. Instead
// `ensureGeneratedInbounds()` auto-seeds one inbound per supported
// (protocol x transport) combination, all running behind Railway's
// own edge TLS on its single public port -- see docs/how-program-work.md.
'use strict';

const crypto = require('crypto');
const { db, getConfigValue, setConfigValue } = require('./db');
const { getCore, listCores } = require('./cores');
const { generatePath, generateRawHttpPath, generateRealityKeypair, generateShortId, REALITY_DEST } = require('./utils');
const { getModeState, isRowEnabled } = require('./modes');

// Every (core x protocol x transport) combination this panel
// generates. Xray-only (sing-box support was removed 2026-08-29 per
// user request -- see docs/how-program-work.md's Change Log).
// Credentials are generated once per protocol (not per transport) and
// reused across every row of that protocol, so a given protocol is
// one account with many front doors, not a separate identity per
// transport. Order here is also seeding order, so it determines
// inbound ids (and therefore each row's internal port -- see
// xray/config.js).
const CORE_COMBOS = {
  xray: {
    protocols: ['vless', 'trojan'],
    transports: ['ws', 'xhttp', 'httpupgrade', 'raw'],
  },
};

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
 * Delete any `inbounds` row whose `core` value isn't a currently
 * registered core (see src/cores/index.js). Handles leftover rows
 * from a core that used to exist but was later removed from the
 * codebase (e.g. sing-box, removed 2026-08-29) -- those rows are
 * never started by reloadCore() (it filters by core name), but
 * listInbounds() still returns them, so without this cleanup they
 * keep showing up as permanently "unknown"-health cards on the
 * dashboard/Subscription Panel and drag the active/total count down.
 * Safe to run on every boot: a no-op once no such rows remain.
 */
function pruneOrphanedCoreRows() {
  const validCores = listCores().map((core) => core.name);
  if (validCores.length === 0) return; // safety: never wipe everything if cores/index.js is empty
  const placeholders = validCores.map(() => '?').join(',');
  db.prepare(`DELETE FROM inbounds WHERE core NOT IN (${placeholders})`).run(...validCores);
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

  // REALITY is seeded separately (not part of CORE_COMBOS's protocol x
  // transport matrix -- it's one extra vless row, not a full combo) and
  // has its own idempotency check, so it still runs even when the
  // matrix above was already seeded on a prior boot.
  ensureRealityInbound();
}

/**
 * Idempotently seed the single REALITY inbound row (protocol vless,
 * transport 'reality'). Reuses the same vless `client_uuid` every
 * other vless row uses -- one account, many front doors, same design
 * as CORE_COMBOS's shared-credentials-per-protocol approach above.
 * REALITY's keypair/short ID/camouflage target are generated once and
 * stored directly on the row so xray/config.js can build its inbound
 * with no DB access of its own. Safe to call on every boot: a no-op
 * once the row already exists.
 */
function ensureRealityInbound() {
  const existing = db.prepare("SELECT id FROM inbounds WHERE transport = 'reality'").get();
  if (existing) return;

  const vlessRow = db.prepare("SELECT client_uuid FROM inbounds WHERE protocol = 'vless' LIMIT 1").get();
  const clientUuid = vlessRow ? vlessRow.client_uuid : crypto.randomUUID();
  const { privateKey, publicKey } = generateRealityKeypair();
  const shortId = generateShortId();

  db.prepare(
    `INSERT INTO inbounds (
      core, protocol, transport, path, client_uuid, subscription_id,
      reality_private_key, reality_public_key, reality_short_id, reality_dest
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'xray',
    'vless',
    'reality',
    '', // no WS-style path -- REALITY is raw TCP, this column is unused for it
    clientUuid,
    crypto.randomBytes(16).toString('hex'),
    privateKey,
    publicKey,
    shortId,
    REALITY_DEST
  );
}

/**
 * Save the admin-entered Railway TCP Proxy address ("host:port") that
 * REALITY's share link should point at (see xray/links.js's
 * buildRealityLink()). Doesn't restart any core -- REALITY's xray-core
 * inbound already listens on 0.0.0.0 regardless of whether an
 * external address has been recorded yet; this only changes what the
 * generated link displays.
 */
function setRealityExternalAddress(address) {
  db.prepare("UPDATE inbounds SET reality_external_address = ? WHERE transport = 'reality'").run(address);
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
 * row is served unless its mode (protocol/transport) has been
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
  pruneOrphanedCoreRows,
  ensureGeneratedInbounds,
  ensureRealityInbound,
  setRealityExternalAddress,
  getOrCreateGlobalSubscriptionId,
  addClientTraffic,
  reloadCore,
  reloadCores,
};
