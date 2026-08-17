// Small shared helpers used by views (passed in as EJS locals).
'use strict';

const crypto = require('crypto');

/**
 * Format a byte count as a human-readable string (e.g. "1.3 GB").
 * Matches the binary (1024-based) convention 3x-ui and most VPN
 * panels use for traffic display.
 */
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  const decimals = exponent === 0 ? 0 : 2;

  return `${value.toFixed(decimals)} ${units[exponent]}`;
}

// QR icon used on share-link buttons. viewBox/paths preserved as-is;
// only the fill is swapped for currentColor so it follows button text
// color (theme-aware) instead of being hardcoded black.
const QR_ICON_SVG = `<svg viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
<path d="M5.6,4A1.6,1.6,0,0,0,4,5.6V12h8V4ZM10,10H6V6h4Z"></path><path d="M4,30.4A1.6,1.6,0,0,0,5.6,32H12V24H4ZM6,26h4v4H6Z"></path><path d="M24,32h6.4A1.6,1.6,0,0,0,32,30.4V24H24Zm2-6h4v4H26Z"></path><path d="M30.4,4H24v8h8V5.6A1.6,1.6,0,0,0,30.4,4ZM30,10H26V6h4Z"></path><polygon points="20 10 20 8 16 8 16 12 18 12 18 10 20 10"></polygon><rect x="12" y="12" width="2" height="2"></rect><rect x="14" y="14" width="4" height="2"></rect><polygon points="20 6 20 8 22 8 22 4 14 4 14 8 16 8 16 6 20 6"></polygon><rect x="4" y="14" width="2" height="4"></rect><polygon points="12 16 12 18 10 18 10 14 8 14 8 18 6 18 6 20 4 20 4 22 8 22 8 20 10 20 10 22 12 22 12 20 14 20 14 16 12 16"></polygon><polygon points="20 16 22 16 22 18 24 18 24 16 26 16 26 14 22 14 22 10 20 10 20 12 18 12 18 14 20 14 20 16"></polygon><polygon points="18 30 14 30 14 32 22 32 22 30 20 30 20 28 18 28 18 30"></polygon><polygon points="22 20 22 18 20 18 20 16 18 16 18 18 16 18 16 20 18 20 18 22 20 22 20 20 22 20"></polygon><rect x="30" y="20" width="2" height="2"></rect><rect x="22" y="20" width="6" height="2"></rect><polygon points="30 14 28 14 28 16 26 16 26 18 28 18 28 20 30 20 30 18 32 18 32 16 30 16 30 14"></polygon><rect x="20" y="22" width="2" height="6"></rect><polygon points="14 28 16 28 16 26 18 26 18 24 16 24 16 20 14 20 14 28"></polygon>
</svg>`;

/** Random URL path, unique per generated inbound (used for share-link path + request routing). */
function generatePath() {
  return `/${crypto.randomBytes(6).toString('hex')}`;
}

/** Random Shadowsocks password (base64, used with a fixed AEAD method). */
function generateSsPassword() {
  return crypto.randomBytes(16).toString('base64');
}

// ALPN and TLS-fingerprint variants offered per inbound. These are
// link-only (client-side) values — Railway's edge, not xray, performs
// the real TLS handshake — so they don't affect server config, only
// which share-link variants get generated (see xray/links.js).
const ALPN_VARIANTS = ['http/1.1', 'h2', 'h2,http/1.1'];
const FINGERPRINTS = ['chrome', 'firefox', 'safari', 'ios', 'android', 'randomized'];

module.exports = {
  formatBytes,
  QR_ICON_SVG,
  generatePath,
  generateSsPassword,
  ALPN_VARIANTS,
  FINGERPRINTS,
};
