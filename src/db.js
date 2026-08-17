// Database setup for SOLO Panel.
//
// Uses SQLite (better-sqlite3), stored on a Railway Volume mounted at
// the path given by DATA_DIR (defaults to ./data for local dev), so
// data survives redeploys without needing an external DB account.
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
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

// Inbounds table: one row per auto-generated Xray-core inbound. The
// panel no longer lets the admin hand-create/name inbounds — instead
// it seeds exactly one row per (transport x alpn) combination that
// Railway + REALITY can actually support (see
// `inbounds.js#ensureGeneratedInbounds` and docs/how-program-work.md),
// all sharing one REALITY keypair and one client UUID so every row is
// just a different front door to the same account. `external_port`
// holds the Railway-assigned TCP Proxy port for this row's internal
// port; the host is NOT stored per row anymore — every TCP Proxy on
// the same Railway service shares one host, so that lives once in
// `app_config` (see `getExternalHost`/`setExternalHost` below).
// `transport` is 'tcp' (raw, XTLS Vision), 'grpc', or 'xhttp'. This is
// a breaking schema change from the earlier admin-managed-inbounds
// design: if an `inbounds` table already exists in an old shape (has
// a `remark` or `external_host` column, neither of which the new
// schema has), drop and recreate it fresh rather than attempt a
// column-by-column migration — old inbounds are not carried forward,
// they get regenerated automatically on next boot. Leaves an
// already-new-shape table alone.
const existingInboundColumns = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inbounds'")
  .get()
  ? db.prepare('PRAGMA table_info(inbounds)').all().map((c) => c.name)
  : [];
if (
  existingInboundColumns.includes('remark') ||
  existingInboundColumns.includes('protocol') ||
  existingInboundColumns.includes('external_host')
) {
  db.exec('DROP TABLE inbounds');
}
db.exec(`
  CREATE TABLE IF NOT EXISTS inbounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transport TEXT NOT NULL,
    fingerprint TEXT NOT NULL DEFAULT 'chrome',
    alpn TEXT NOT NULL,
    grpc_service_name TEXT,
    xhttp_path TEXT,
    reality_dest TEXT NOT NULL,
    reality_server_name TEXT NOT NULL,
    reality_private_key TEXT NOT NULL,
    reality_public_key TEXT NOT NULL,
    reality_short_id TEXT NOT NULL,
    client_uuid TEXT NOT NULL,
    subscription_id TEXT NOT NULL,
    up_bytes INTEGER NOT NULL DEFAULT 0,
    down_bytes INTEGER NOT NULL DEFAULT 0,
    external_port INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

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

module.exports = { db, getOrCreateSessionSecret, getConfigValue, setConfigValue };
