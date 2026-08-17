// Authentication helpers for SOLO Panel.
//
// Auth model: single admin account stored in SQLite (admin_users table),
// password hashed with bcrypt, session tracked via express-session
// (cookie-based, server-side memory store for now — fine for a single
// small panel instance; can move to a store later if needed).
'use strict';

const bcrypt = require('bcryptjs');
const { db } = require('./db');

const SALT_ROUNDS = 10;

/**
 * On first startup, if no admin user exists yet, create the single
 * admin account. Username is always "admin" (this panel supports
 * exactly one admin — see server.js, no account-creation route
 * exists). Password comes from ADMIN_PASSWORD (falls back to "admin"
 * for local dev only — must be changed before real deployment).
 */
function seedAdminFromEnv() {
  const existing = db.prepare('SELECT id FROM admin_users LIMIT 1').get();
  if (existing) return;

  const username = 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin';
  const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);

  db.prepare('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)')
    .run(username, passwordHash);

  console.log(`Seeded initial admin user "${username}". Change this password after first login.`);
}

/**
 * Verify a username/password pair against the stored admin user.
 * Returns the user row (without password_hash) on success, or null.
 */
function verifyLogin(username, password) {
  const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
  if (!user) return null;

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return null;

  return { id: user.id, username: user.username };
}

/**
 * Express middleware: require an authenticated session, else redirect
 * to the login page.
 */
function requireAuth(req, res, next) {
  if (req.session && req.session.adminId) {
    return next();
  }
  return res.redirect('/login');
}

module.exports = {
  seedAdminFromEnv,
  verifyLogin,
  requireAuth,
};
