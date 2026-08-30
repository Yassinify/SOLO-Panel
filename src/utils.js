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

// Harder-to-guess path for the `raw` transport's HTTP-obfuscation
// header: base64 of a small JSON blob (junk + protocol/mode markers,
// matching the shape real clients like v2rayNG/NekoBox expect on the
// wire) instead of a plain hex string, plus an `?ed=2560` early-data
// query hint. Longer and less guessable than generatePath()'s bare
// 12-hex-char path.
function generateRawHttpPath() {
  const junk = crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
  const payload = { junk, protocol: 'vl', mode: 'proxyip', panelIPs: [] };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  return `/${encoded}?ed=2560`;
}

// ALPN and TLS-fingerprint variants offered per inbound. These are
// link-only (client-side) values — Railway's edge, not xray, performs
// the real TLS handshake — so they don't affect server config, only
// which share-link variants get generated (see xray/links.js).
const ALPN_VARIANTS = ['http/1.1', 'h2', 'h2,http/1.1'];
const FINGERPRINTS = ['chrome', 'firefox', 'safari', 'ios', 'android', 'randomized'];

// Country flag for the Railway region this deployment is running in,
// keyed by the `RAILWAY_REPLICA_REGION` env var's region identifier
// prefix (Railway sets this automatically per deployment — see
// https://docs.railway.com/deployments/regions for the current list;
// more regions may be added later). Matched by prefix since the full
// identifier can carry a datacenter suffix (e.g. `us-east4-eqdc4a`).
const REGION_FLAGS = [
  { prefix: 'us-west', flag: '\u{1F1FA}\u{1F1F8}', name: 'United States (West)', country: 'United States' }, // US West Metal (California)
  { prefix: 'us-east', flag: '\u{1F1FA}\u{1F1F8}', name: 'United States (East)', country: 'United States' }, // US East Metal (Virginia)
  { prefix: 'europe-west', flag: '\u{1F1F3}\u{1F1F1}', name: 'Netherlands', country: 'Netherlands' }, // EU West Metal (Amsterdam)
  { prefix: 'asia-southeast', flag: '\u{1F1F8}\u{1F1EC}', name: 'Singapore', country: 'Singapore' }, // Southeast Asia Metal (Singapore)
];

/**
 * Country flag emoji for the Railway region this instance is running
 * in, or '' if `RAILWAY_REPLICA_REGION` isn't set (e.g. local dev) or
 * doesn't match a known region.
 */
function regionFlag() {
  const region = process.env.RAILWAY_REPLICA_REGION || '';
  const match = REGION_FLAGS.find((r) => region.startsWith(r.prefix));
  return match ? match.flag : '';
}

/**
 * Human-readable location name for the same region lookup as
 * `regionFlag()` (vision rule 21: automatic country detection), or
 * '\ud83c\udf10' (globe, vision rule 21's documented fallback) if the region
 * can't be determined.
 */
function regionName() {
  const region = process.env.RAILWAY_REPLICA_REGION || '';
  const match = REGION_FLAGS.find((r) => region.startsWith(r.prefix));
  return match ? match.name : '\u{1F310}';
}

/**
 * Every country Railway can deploy this app to (not just the one this
 * instance is currently running in), deduped by country -- e.g. the
 * two US regions collapse into one "United States" entry. Used by the
 * admin dashboard's Location section. Same source table as
 * regionFlag()/regionName() (docs.railway.com/deployments/regions).
 */
function regionList() {
  const seen = new Set();
  const list = [];
  for (const r of REGION_FLAGS) {
    if (seen.has(r.country)) continue;
    seen.add(r.country);
    list.push({ flag: r.flag, name: r.country });
  }
  return list;
}

// Short, plain-language explanations for technical connection fields
// (vision rules 16/31): the Subscription Web Panel shows these next to
// each field instead of expecting users to already know what ALPN,
// SNI, etc. mean.
const TECH_EXPLANATIONS = {
  core: 'The underlying proxy engine that handles this connection.',
  protocol: 'The proxy protocol this link uses to carry your traffic.',
  transport: 'How the connection is wrapped so it blends in with normal web traffic.',
  security: 'Whether the connection is encrypted end-to-end.',
  tls: 'The encryption layer that protects your traffic in transit, provided by Railway\u2019s network edge.',
  sni: 'The server name sent during the secure handshake, used to route your connection to the right host.',
  alpn: 'Used to negotiate which application protocol (e.g. HTTP/2) the secure connection will speak.',
  fingerprint: 'Makes the connection\u2019s handshake resemble a specific browser, so it looks like ordinary traffic.',
  location: 'The physical region this deployment is running in.',
  status: 'Whether this endpoint is currently reachable and responding normally.',
};

/** Short explanation text for one technical field key, or '' if unknown. */
function explainField(key) {
  return TECH_EXPLANATIONS[key] || '';
}

module.exports = {
  formatBytes,
  QR_ICON_SVG,
  generatePath,
  generateRawHttpPath,
  ALPN_VARIANTS,
  FINGERPRINTS,
  regionFlag,
  regionName,
  regionList,
  TECH_EXPLANATIONS,
  explainField,
};
