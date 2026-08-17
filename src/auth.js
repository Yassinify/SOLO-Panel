// Authentication helpers for SOLO Panel.
//
// Auth model: single admin account stored in SQLite (admin_users table),
// password hashed with bcrypt, session tracked via express-session
// (cookie-based, server-side memory store for now — fine for a single
// small panel instance; can move to a store later if needed).
'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { db } = require('./db');

const SALT_ROUNDS = 10;

/**
 * On first startup, if no admin user exists yet, create the single
 * admin account. Password-only login — no username (this panel
 * supports exactly one admin — see server.js, no account-creation
 * route exists). Password comes from ADMIN_PASSWORD (falls back to
 * "admin" for local dev only — must be changed before real
 * deployment).
 */
function seedAdminFromEnv() {
  const existing = db.prepare('SELECT id FROM admin_users LIMIT 1').get();
  if (existing) return;

  const password = process.env.ADMIN_PASSWORD || 'admin';
  const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);

  db.prepare('INSERT INTO admin_users (password_hash) VALUES (?)').run(passwordHash);

  console.log('Seeded initial admin account. Change ADMIN_PASSWORD after first login.');
}

/**
 * Verify a password against the stored (single) admin user.
 * Returns the user row (without password_hash) on success, or null.
 */
function verifyLogin(password) {
  const user = db.prepare('SELECT * FROM admin_users LIMIT 1').get();
  if (!user) return null;

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return null;

  return { id: user.id };
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

/**
 * Returns this session's CSRF token, generating and persisting one on
 * first call. Works pre-login too (the login form itself needs a
 * token) — express-session's `saveUninitialized: false` only skips
 * saving sessions that were never touched, and writing to
 * `req.session` here counts as touching it, so the session (and this
 * token) is saved even for a not-yet-logged-in visitor.
 */
function getOrCreateCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  return req.session.csrfToken;
}

/**
 * Express middleware: reject (403) any POST whose `_csrf` body field
 * doesn't match this session's token. Must run after the session
 * middleware and `express.urlencoded()` (so `req.body` is populated),
 * and before the route handler. Every state-changing POST route in
 * this panel uses it — see server.js.
 */
function requireCsrf(req, res, next) {
  const submitted = req.body && req.body._csrf;
  const expected = req.session && req.session.csrfToken;
  if (!expected || submitted !== expected) {
    return res.status(403).send('Invalid or missing CSRF token. Go back and try again.');
  }
  next();
}

module.exports = {
  seedAdminFromEnv,
  verifyLogin,
  requireAuth,
  getOrCreateCsrfToken,
  requireCsrf,
};
