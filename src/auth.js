// Authentication helpers for SOLO Panel: single admin account,
// bcrypt password hash, session-based login, CSRF checks.
'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { db } = require('./db');

const SALT_ROUNDS = 10;

// Create the single admin account on first startup (no-op if one exists).
function seedAdminFromEnv() {
  const existing = db.prepare('SELECT id FROM admin_users LIMIT 1').get();
  if (existing) return;

  const password = process.env.ADMIN_PASSWORD || 'admin';
  const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);

  db.prepare('INSERT INTO admin_users (password_hash) VALUES (?)').run(passwordHash);

  console.log('Seeded initial admin account. Change ADMIN_PASSWORD after first login.');
}

// Check a password against the stored admin user.
function verifyLogin(password) {
  const user = db.prepare('SELECT * FROM admin_users LIMIT 1').get();
  if (!user) return null;

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return null;

  return { id: user.id };
}

// Overwrites the single admin account's password hash.
function updatePassword(newPassword) {
  const passwordHash = bcrypt.hashSync(newPassword, SALT_ROUNDS);
  db.prepare('UPDATE admin_users SET password_hash = ?').run(passwordHash);
}

// Middleware: require a logged-in session, else redirect to /login.
function requireAuth(req, res, next) {
  if (req.session && req.session.adminId) {
    return next();
  }
  return res.redirect('/login');
}

// Get (or create) this session's CSRF token.
function getOrCreateCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  return req.session.csrfToken;
}

// Middleware: reject POSTs whose _csrf field doesn't match the session token.
// Uses a timing-safe comparison so response time can't leak how many
// characters of the token an attacker has guessed correctly.
function requireCsrf(req, res, next) {
  const submitted = req.body && req.body._csrf;
  const expected = req.session && req.session.csrfToken;
  if (!expected || !timingSafeEqualStrings(submitted, expected)) {
    return res.status(403).send('Invalid or missing CSRF token. Go back and try again.');
  }
  next();
}

// Constant-time string comparison (avoids leaking match length via
// timing). Returns false immediately -- safely -- if either input
// isn't a usable string or the lengths differ.
function timingSafeEqualStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = {
  seedAdminFromEnv,
  verifyLogin,
  updatePassword,
  requireAuth,
  getOrCreateCsrfToken,
  requireCsrf,
};
