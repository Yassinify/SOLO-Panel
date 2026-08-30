// Custom express-session store backed by the existing SQLite DB.
//
// Replaces express-session's default MemoryStore -- a real Railway
// deploy log flagged that store as unsuitable for production ("will
// leak memory, and will not scale past a single process"), and its
// bigger practical problem for this single-instance panel is that it
// clears every session (logging the admin out) on every redeploy or
// restart. No new npm dependency: implemented directly against
// express-session's own Store base class, same "small dependency-free
// implementation" approach this project already used for CSRF
// protection (see src/auth.js's requireCsrf).
'use strict';

const session = require('express-session');
const { db } = require('./db');

// Default session lifetime used when a session has no explicit
// cookie.expires (e.g. a non-persistent "session cookie") -- matches
// express-session's own default maxAge fallback (24 hours) so
// unattended rows don't linger indefinitely in the sessions table.
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

class SqliteSessionStore extends session.Store {
  get(sid, callback) {
    try {
      const row = db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?').get(sid);
      if (!row) return callback(null, null);
      if (row.expires_at < Date.now()) {
        // Lazily clean up an expired row instead of running a
        // separate cleanup job -- the sessions table only ever grows
        // by one row per login anyway (single admin, per auth.js).
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.data));
    } catch (err) {
      callback(err);
    }
  }

  set(sid, sessionData, callback) {
    try {
      const expiresAt = sessionData.cookie && sessionData.cookie.expires
        ? new Date(sessionData.cookie.expires).getTime()
        : Date.now() + DEFAULT_MAX_AGE_MS;
      db.prepare(
        `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`
      ).run(sid, JSON.stringify(sessionData), expiresAt);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  // Refresh a session's expiry on activity (express-session calls
  // this instead of set() when `resave: false` and the session
  // itself hasn't changed) -- same expiry logic as set() above.
  touch(sid, sessionData, callback) {
    this.set(sid, sessionData, callback);
  }
}

module.exports = SqliteSessionStore;
