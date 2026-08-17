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
// panel seeds exactly one row per (protocol x transport) combination
// (see `inbounds.js#ensureGeneratedInbounds` and
// docs/how-program-work.md) — protocol is 'vless'/'vmess'/'trojan'/
// 'shadowsocks', transport is 'ws'/'xhttp'/'httpupgrade'. All of them
// run behind Railway's own edge TLS on the single public port (no
// REALITY, no admin-configured TCP Proxy / host / port anymore — see
// Change Log). ALPN and TLS fingerprint don't change server-side
// behavior (Railway's edge does the real TLS handshake, not xray), so
// they are NOT stored per row — they're generated as link-only
// variants at share-link build time (see xray/links.js). Credentials
// are shared across every row of the same protocol, so every
// generated config is a different front door to the same account.
// Breaking schema change from the REALITY design: if an `inbounds`
// table already exists in the old shape (has a `reality_dest` or
// `fingerprint` column, neither of which the new schema has), drop
// and recreate it fresh — old inbounds regenerate automatically on
// next boot. Leaves an already-new-shape table alone.
const existingInboundColumns = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inbounds'")
  .get()
  ? db.prepare('PRAGMA table_info(inbounds)').all().map((c) => c.name)
  : [];
if (
  existingInboundColumns.includes('remark') ||
  existingInboundColumns.includes('external_host') ||
  existingInboundColumns.includes('reality_dest') ||
  existingInboundColumns.includes('fingerprint')
) {
  db.exec('DROP TABLE inbounds');
}
db.exec(`
  CREATE TABLE IF NOT EXISTS inbounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
