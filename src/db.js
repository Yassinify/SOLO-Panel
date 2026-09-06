// Database setup for SOLO Panel. Uses SQLite (better-sqlite3), stored
// on a Railway Volume so data survives redeploys. Storage dir order:
// DATA_DIR env -> RAILWAY_VOLUME_MOUNT_PATH -> ./data (local dev).
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

// Rename an old-shaped table out of the way instead of dropping it,
// so a future schema change can't silently destroy real data (the DB
// now persists on a Railway Volume). Kept lightweight for Railway's
// free-tier storage limits: this is a rename, not a copy, and the
// tables involved are tiny (a handful of rows for a single-admin
// panel) -- negligible extra disk usage. Old backups aren't
// auto-deleted; safe to remove manually once confirmed unneeded.
function renameOldTable(tableName) {
  const backupName = `${tableName}_backup_${Date.now()}`;
  console.warn(
    `[db] '${tableName}' table is in an old shape; renaming it to ` +
    `'${backupName}' instead of dropping it, then recreating '${tableName}' fresh. ` +
    `Your previous data is preserved in '${backupName}' if you need to recover it.`
  );
  db.exec(`ALTER TABLE ${tableName} RENAME TO ${backupName}`);
}

// Admin users table: single admin, password-only login (see auth.js).
// Rename-and-recreate if an older shape (has `username`) exists.
const existingAdminColumns = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='admin_users'")
  .get()
  ? db.prepare('PRAGMA table_info(admin_users)').all().map((c) => c.name)
  : [];
if (existingAdminColumns.includes('username')) {
  renameOldTable('admin_users');
}
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Inbounds table: one row per auto-generated inbound (see
// inbounds.js#ensureGeneratedInbounds). `core` is always 'xray'.
// ALPN/fingerprint aren't stored per row — generated at share-link
// build time instead (see xray/links.js).
// Rename-and-recreate the table if it's in an old pre-`core`-column shape.
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
  renameOldTable('inbounds');
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
    subscription_id TEXT NOT NULL,
    up_bytes INTEGER NOT NULL DEFAULT 0,
    down_bytes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
// Old per-inbound clients table from an earlier design — no longer used.
db.exec('DROP TABLE IF EXISTS inbound_clients');

// Small key/value config table for panel-generated values (e.g. a
// fallback session secret), persisted alongside everything else.
db.exec(`
  CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Persisted fallback secret for signing session cookies, used only if
// SESSION_SECRET env var isn't set. Generated once, stored in app_config.
function getOrCreateSessionSecret() {
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get('session_secret');
  if (row) return row.value;

  const secret = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?)').run('session_secret', secret);
  return secret;
}

// Read a value from `app_config`, or null if never set.
function getConfigValue(key) {
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

// Insert-or-update a value in `app_config`.
function setConfigValue(key, value) {
  db.prepare(
    'INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

// Session storage table backing sessionStore.js's custom express-session
// Store (replaces the default in-memory store, which loses sessions on
// every restart). Expired rows are lazily deleted on read.
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

module.exports = { db, DATA_DIR, getOrCreateSessionSecret, getConfigValue, setConfigValue };
