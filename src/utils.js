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

function base64Url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate a REALITY-compatible X25519 key pair, using Node's native
 * x25519 support rather than shelling out to the xray binary. Raw key
 * bytes are the last 32 bytes of the fixed-length PKCS8/SPKI DER
 * encodings Node produces for x25519 — a standard, well-known trick
 * (same technique used for WireGuard keys), avoiding any dependency
 * on xray-core being present at inbound-creation time.
 */
function generateRealityKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  const pubDer = publicKey.export({ type: 'spki', format: 'der' });
  return {
    privateKey: base64Url(privDer.subarray(privDer.length - 32)),
    publicKey: base64Url(pubDer.subarray(pubDer.length - 32)),
  };
}

/** Short hex ID for REALITY's shortIds list (client must send a matching one). */
function generateRealityShortId() {
  return crypto.randomBytes(4).toString('hex');
}

/** Random gRPC service name, used when transport is 'grpc'. */
function generateGrpcServiceName() {
  return crypto.randomBytes(6).toString('hex');
}

/** Random URL path, used when transport is 'xhttp'. */
function generateXhttpPath() {
  return `/${crypto.randomBytes(6).toString('hex')}`;
}

module.exports = {
  formatBytes,
  QR_ICON_SVG,
  generateRealityKeyPair,
  generateRealityShortId,
  generateGrpcServiceName,
  generateXhttpPath,
};
