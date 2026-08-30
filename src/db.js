// Database setup for SOLO Panel.
//
// Uses SQLite (better-sqlite3), stored on a Railway Volume so data
// survives redeploys without needing an external DB account. The
// storage directory is resolved as: an explicit DATA_DIR env var (if
// set) -> Railway's own RAILWAY_VOLUME_MOUNT_PATH (auto-injected once
// a Volume is attached to the service, no manual variable needed) ->
// ./data for local dev. See docs/how-program-work.md's Change Log for
// why the RAILWAY_VOLUME_MOUNT_PATH fallback was added.
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'panel.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Admin users table: single panel administrator, password-only login
// (no username field — see auth.js). If an older-shape table exists
// (has a `username` column), drop and recreate it fresh, same pattern
// as the `inbounds` migration below; the admin just re-logs-in with
// ADMIN_PASSWORD after upgrade.
const existingAdminColumns = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='admin_users'")
  .get()
  ? db.prepare('PRAGMA table_info(admin_users)').all().map((c) => c.name)
  : [];
if (existingAdminColumns.includes('username')) {
  db.exec('DROP TABLE admin_users');
}
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Inbounds table: one row per auto-generated inbound (see
// `inbounds.js#ensureGeneratedInbounds` and src/cores/index.js).
// `core` is always 'xray' -- sing-box support was removed 2026-08-29
// per user request (see docs/how-program-work.md's Change Log); the
// column is kept as-is (no migration needed) rather than dropped.
// Every row except the REALITY one runs behind Railway's own edge TLS
// on the single public port; the REALITY row (transport = 'reality')
// is the one exception -- it needs its own separately-exposed port
// via an admin-attached Railway TCP Proxy (see xray/config.js's
// header and inbounds.js's ensureRealityInbound()). ALPN and TLS
// fingerprint don't change server-side behavior for every other
// transport (Railway's edge does the real TLS handshake, not the
// core), so they are NOT stored per row - they're generated as
// link-only variants at share-link build time (see xray/links.js).
// Credentials are shared across every row of the same protocol, so
// every generated config is a different front door to the same
// account.
// Breaking schema change note: if an `inbounds` table already exists
// without a `core` column (pre-multi-core shape), or in an even older
// shape (REALITY-era columns), drop and recreate it fresh - old
// inbounds regenerate automatically on next boot. Leaves an
// already-current-shape table alone.
const existingInboundColumns = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inbounds'")
  .get()
  ? db.prepare('PRAGMA table_info(inbounds)').all().map((c) => c.name)
  : [];
if (
  existingInboundColumns.includes('remark') ||
  existingInboundColumns.includes('external_host') ||
  existingInboundColumns.includes('fingerprint') ||
  (existingInboundColumns.length > 0 && !existingInboundColumns.includes('core'))
) {
  db.exec('DROP TABLE inbounds');
}
db.exec(`
  CREATE TABLE IF NOT EXISTS inbounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    core TEXT NOT NULL DEFAULT 'xray',
    protocol TEXT NOT NULL,
    transport TEXT NOT NULL,
    path TEXT NOT NULL,
    client_uuid TEXT,
    trojan_password TEXT,
    ss_method TEXT,
    ss_password TEXT,
    subscription_id TEXT NOT NULL,
    up_bytes INTEGER NOT NULL DEFAULT 0,
    down_bytes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
// REALITY columns: additive (ALTER TABLE ADD COLUMN), not part of the
// CREATE TABLE above, so upgrading an existing deployment never loses
// its already-generated credentials/traffic totals for a DROP-and-
// regenerate. Added only if missing (idempotent -- safe on every
// boot). `reality_external_address` is the one genuinely admin-
// entered value (Railway TCP Proxy's assigned "host:port"); the rest
// are generated once by inbounds.js's ensureRealityInbound().
const realityColumnsToAdd = [
  'reality_private_key',
  'reality_public_key',
  'reality_short_id',
  'reality_dest',
  'reality_external_address',
];
for (const column of realityColumnsToAdd) {
  if (!existingInboundColumns.includes(column) && !db.prepare('PRAGMA table_info(inbounds)').all().some((c) => c.name === column)) {
    db.exec(`ALTER TABLE inbounds ADD COLUMN ${column} TEXT`);
  }
}

// Drop the old separate clients table from earlier versions of this
// panel (WS transport, multi-client-per-inbound) — clients now live
// directly on the inbounds row.
db.exec('DROP TABLE IF EXISTS inbound_clients');

// Small key/value config table for values the panel generates itself
// (e.g. an auto-generated session secret) rather than getting from an
// env var. Lives in the same SQLite file as everything else, so it is
// persisted by the same Railway Volume / DATA_DIR as the rest of the
// panel's data.
db.exec(`
  CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

/**
 * Returns a persisted random secret for signing session cookies. If
 * SESSION_SECRET is set as an env var, callers should prefer that
 * instead (see src/server.js) — this is only the fallback for forks/
 * deployments that don't set one, so sessions still survive restarts
 * without every unconfigured deployment sharing one hardcoded secret.
 * Generated once and stored in app_config on first call.
 */
function getOrCreateSessionSecret() {
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get('session_secret');
  if (row) return row.value;

  const secret = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?)').run('session_secret', secret);
  return secret;
}

/** Read a value from `app_config`, or null if it was never set. */
function getConfigValue(key) {
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

/** Insert-or-update a value in `app_config`. */
function setConfigValue(key, value) {
  db.prepare(
    'INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

// Session storage table, backing src/sessionStore.js's custom
// express-session Store (replaces the default in-memory MemoryStore,
// which a real Railway deploy log flagged as unsuitable for
// production -- every redeploy/restart would otherwise clear all
// sessions, logging the admin out). `expires_at` is a Unix ms
// timestamp; expired rows are lazily deleted on read (see
// sessionStore.js) rather than needing a separate cleanup job.
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

module.exports = { db, getOrCreateSessionSecret, getConfigValue, setConfigValue };
