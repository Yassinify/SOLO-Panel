// Small shared helpers used by views (passed in as EJS locals).
'use strict';

const crypto = require('crypto');
const https = require('https');

// Format a byte count as a human-readable string (e.g. "1.3 GB").
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  const decimals = exponent === 0 ? 0 : 2;

  return `${value.toFixed(decimals)} ${units[exponent]}`;
}

// QR icon used on share-link buttons. Fill is currentColor so it follows button text color.
const QR_ICON_SVG = `<svg viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
<path d="M5.6,4A1.6,1.6,0,0,0,4,5.6V12h8V4ZM10,10H6V6h4Z"></path><path d="M4,30.4A1.6,1.6,0,0,0,5.6,32H12V24H4ZM6,26h4v4H6Z"></path><path d="M24,32h6.4A1.6,1.6,0,0,0,32,30.4V24H24Zm2-6h4v4H26Z"></path><path d="M30.4,4H24v8h8V5.6A1.6,1.6,0,0,0,30.4,4ZM30,10H26V6h4Z"></path><polygon points="20 10 20 8 16 8 16 12 18 12 18 10 20 10"></polygon><rect x="12" y="12" width="2" height="2"></rect><rect x="14" y="14" width="4" height="2"></rect><polygon points="20 6 20 8 22 8 22 4 14 4 14 8 16 8 16 6 20 6"></polygon><rect x="4" y="14" width="2" height="4"></rect><polygon points="12 16 12 18 10 18 10 14 8 14 8 18 6 18 6 20 4 20 4 22 8 22 8 20 10 20 10 22 12 22 12 20 14 20 14 16 12 16"></polygon><polygon points="20 16 22 16 22 18 24 18 24 16 26 16 26 14 22 14 22 10 20 10 20 12 18 12 18 14 20 14 20 16"></polygon><polygon points="18 30 14 30 14 32 22 32 22 30 20 30 20 28 18 28 18 30"></polygon><polygon points="22 20 22 18 20 18 20 16 18 16 18 18 16 18 16 20 18 20 18 22 20 22 20 20 22 20"></polygon><rect x="30" y="20" width="2" height="2"></rect><rect x="22" y="20" width="6" height="2"></rect><polygon points="30 14 28 14 28 16 26 16 26 18 28 18 28 20 30 20 30 18 32 18 32 16 30 16 30 14"></polygon><rect x="20" y="22" width="2" height="6"></rect><polygon points="14 28 16 28 16 26 18 26 18 24 16 24 16 20 14 20 14 28"></polygon>
</svg>`;

// Random URL path, unique per generated inbound.
function generatePath() {
  return `/${crypto.randomBytes(6).toString('hex')}`;
}

// ALPN and TLS-fingerprint variants offered per inbound. Link-only
// (client-side) values -- Railway's edge does the real TLS handshake.
const ALPN_VARIANTS = ['http/1.1', 'h2'];
const FINGERPRINTS = ['chrome', 'firefox', 'safari', 'ios', 'android', 'randomized'];

// Cached result of the once-at-boot IP geolocation lookup below.
// null until the lookup succeeds; stays null forever if it fails, in
// which case currentRegion() falls back to the Railway-region logic.
let ipRegion = null;

// Builds a flag emoji from a 2-letter ISO country code (e.g. 'nl' ->
// the Netherlands flag), by mapping each letter to its Unicode
// Regional Indicator Symbol.
function flagEmojiFromIso2(iso2) {
  return [...iso2.toUpperCase()].map((c) => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)).join('');
}

// Looks up this server's own public IP's country once at boot (not
// per-request, to avoid an external call + delay on every panel
// view), so the dashboard/subscription panel's Location flag is
// correct from the very first boot -- unlike RAILWAY_REPLICA_REGION,
// which can lag behind on a freshly changed region until Railway
// actually redeploys the container. Failure just leaves `ipRegion`
// null, so currentRegion() silently falls back to the region-based
// logic below.
function detectRegionByIp() {
  const req = https.get('https://ipwho.is/', { timeout: 5000 }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.success !== false && data.country && data.country_code) {
          ipRegion = { flag: flagEmojiFromIso2(data.country_code), name: data.country, iso2: data.country_code.toLowerCase() };
        }
      } catch {
        // Malformed response -- leave ipRegion null, fall back.
      }
    });
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => {
    // Network error / API unreachable -- leave ipRegion null, fall back.
  });
}
detectRegionByIp();

// Country flag for the Railway region this deployment runs in, keyed
// by RAILWAY_REPLICA_REGION's prefix (full identifier can carry a
// datacenter suffix, e.g. `us-east4-eqdc4a`).
const REGION_FLAGS = [
  { prefix: 'us-west', flag: '\u{1F1FA}\u{1F1F8}', name: 'United States (West)', country: 'United States', iso2: 'us' }, // US West Metal (California)
  { prefix: 'us-east', flag: '\u{1F1FA}\u{1F1F8}', name: 'United States (East)', country: 'United States', iso2: 'us' }, // US East Metal (Virginia)
  { prefix: 'europe-west', flag: '\u{1F1F3}\u{1F1F1}', name: 'Netherlands', country: 'Netherlands', iso2: 'nl' }, // EU West Metal (Amsterdam)
  { prefix: 'asia-southeast', flag: '\u{1F1F8}\u{1F1EC}', name: 'Singapore', country: 'Singapore', iso2: 'sg' }, // Southeast Asia Metal (Singapore)
];

// Flag emoji for the current Railway region, or '' if undetermined.
function regionFlag() {
  const region = process.env.RAILWAY_REPLICA_REGION || '';
  const match = REGION_FLAGS.find((r) => region.startsWith(r.prefix));
  return match ? match.flag : '';
}

// Human-readable location name for the current region, or a globe fallback.
function regionName() {
  const region = process.env.RAILWAY_REPLICA_REGION || '';
  const match = REGION_FLAGS.find((r) => region.startsWith(r.prefix));
  return match ? match.name : '\u{1F310}';
}

// Country this deployment is running in (name + iso2 for a flag
// image, since flag emoji don't render on some platforms). Prefers
// the once-at-boot IP geolocation result (see detectRegionByIp()
// above); falls back to RAILWAY_REPLICA_REGION matching, then a
// globe/Unknown placeholder if neither is available. iso2 is null
// only in that final fallback case.
function currentRegion() {
  if (ipRegion) return ipRegion;
  const region = process.env.RAILWAY_REPLICA_REGION || '';
  const match = REGION_FLAGS.find((r) => region.startsWith(r.prefix));
  return match
    ? { flag: match.flag, name: match.country, iso2: match.iso2 }
    : { flag: '\u{1F310}', name: 'Unknown', iso2: null };
}

module.exports = {
  formatBytes,
  QR_ICON_SVG,
  generatePath,
  ALPN_VARIANTS,
  FINGERPRINTS,
  regionFlag,
  regionName,
  currentRegion,
};
