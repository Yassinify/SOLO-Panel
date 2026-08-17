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

// Admin users table: single/multiple panel administrators who can log in.
// Password storage strategy (hashing) will be decided when auth is built.
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Inbounds table: one row per Xray-core inbound the panel manages.
// `config_json` holds the protocol-specific settings/streamSettings
// fragment used when generating the full Xray config (see
// docs/how-program-work.md for why everything runs over the single
// Railway HTTP port via WebSocket/gRPC/XHTTP).
// `transport` is 'ws' (default, shares the single Railway HTTP port)
// or 'tcp' (raw TCP via a manually-configured Railway TCP Proxy;
// `external_host`/`external_port` hold the Railway-assigned address
// once the admin sets that up — see docs/how-program-work.md).
db.exec(`
  CREATE TABLE IF NOT EXISTS inbounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    remark TEXT NOT NULL,
    protocol TEXT NOT NULL,
    listen_path TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    config_json TEXT NOT NULL,
    transport TEXT NOT NULL DEFAULT 'ws',
    external_host TEXT,
    external_port INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migration: add transport/external_host/external_port to installs
// created before these columns existed.
const inboundColumns = db.prepare('PRAGMA table_info(inbounds)').all().map((c) => c.name);
if (!inboundColumns.includes('transport')) {
  db.exec("ALTER TABLE inbounds ADD COLUMN transport TEXT NOT NULL DEFAULT 'ws'");
}
if (!inboundColumns.includes('external_host')) {
  db.exec('ALTER TABLE inbounds ADD COLUMN external_host TEXT');
}
if (!inboundColumns.includes('external_port')) {
  db.exec('ALTER TABLE inbounds ADD COLUMN external_port INTEGER');
}

// Inbound clients table: individual clients (users) attached to an
// inbound, each with their own UUID/password and traffic accounting.
db.exec(`
  CREATE TABLE IF NOT EXISTS inbound_clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inbound_id INTEGER NOT NULL REFERENCES inbounds(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    client_uuid TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    total_bytes_limit INTEGER NOT NULL DEFAULT 0,
    expiry_time INTEGER NOT NULL DEFAULT 0,
    up_bytes INTEGER NOT NULL DEFAULT 0,
    down_bytes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migration: add subscription_id (public, unguessable token used by
// GET /sub/:subId to serve a client's share link without requiring
// panel login) to installs created before this column existed.
const hasSubscriptionId = db
  .prepare("PRAGMA table_info(inbound_clients)")
  .all()
  .some((col) => col.name === 'subscription_id');

if (!hasSubscriptionId) {
  db.exec('ALTER TABLE inbound_clients ADD COLUMN subscription_id TEXT');

  const backfillStmt = db.prepare(
    'UPDATE inbound_clients SET subscription_id = ? WHERE id = ?'
  );
  const rowsNeedingToken = db
    .prepare('SELECT id FROM inbound_clients WHERE subscription_id IS NULL')
    .all();
  for (const row of rowsNeedingToken) {
    backfillStmt.run(crypto.randomBytes(16).toString('hex'), row.id);
  }
}

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

module.exports = { db, getOrCreateSessionSecret };
