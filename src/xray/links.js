// Builds every client-facing share link for one `inbounds` DB row.
// TLS is terminated by Railway's edge, not xray-core, so every link
// uses security=tls on the public port 443 -- ALPN/fingerprint are
// client-side hints only, they don't need to match xray-core config.
// One inbound row fans out into one link per (ALPN x fingerprint) combo.
'use strict';

const { ALPN_VARIANTS, FINGERPRINTS, regionFlag } = require('../utils');

// Railway gives every service one HTTPS domain on the standard port.
const EXTERNAL_PORT = 443;

const FINGERPRINT_LABELS = {
  chrome: 'Chrome',
  firefox: 'Firefox',
  safari: 'Safari',
  ios: 'iOS',
  android: 'Android',
  randomized: 'Randomized',
};

// Grouping label for one DB row (used on the dashboard, which lists
// rows, not individual link variants).
function labelForInbound(inbound) {
  return `${inbound.protocol.toUpperCase()} / ${inbound.transport.toUpperCase()}`;
}

// Per-link remark, e.g. "🇺🇸 VLESS - WS - http/1.1 - Chrome". Port is
// never included -- every link uses the fixed EXTERNAL_PORT (443).
// `ipv6` appends a " - IPv6" suffix -- see modes.js's getIpv6Enabled().
function remarkFor(inbound, alpn, fingerprint, ipv6 = false) {
  const flag = regionFlag();
  const prefix = flag ? `${flag} ` : '';
  const fpLabel = FINGERPRINT_LABELS[fingerprint] || fingerprint;
  const suffix = ipv6 ? ' - IPv6' : '';
  return `${prefix}${inbound.protocol.toUpperCase()} - ${inbound.transport.toUpperCase()} - ${alpn} - ${fpLabel}${suffix}`;
}

// Query params shared by vless/trojan.
function buildTransportParams(inbound, alpn, fingerprint, host) {
  // VLESS URIs require an explicit `encryption` field (always 'none'
  // -- xray-core's transport-layer TLS handles encryption). Trojan
  // URIs don't use this field.
  const paramsObj = inbound.protocol === 'vless' ? { encryption: 'none' } : {};
  Object.assign(paramsObj, {
    type: inbound.transport,
    security: 'tls',
    alpn,
    fp: fingerprint,
    sni: host,
    path: inbound.path,
    host,
  });
  const params = new URLSearchParams(paramsObj);
  if (inbound.transport === 'xhttp') {
    params.set('mode', 'auto');
  }
  return params;
}

// Some (transport x ALPN x fingerprint) combinations never connect
// in practice (confirmed by real client testing):
//   - xhttp's browser fingerprints conflict with plain http/1.1 ALPN;
//     the android fingerprint conflicts with h2.
// So the broken combination is never generated as a link anywhere.
function isBrokenCombo(transport, alpn, fingerprint) {
  if (transport === 'xhttp') {
    if (alpn === 'http/1.1' && ['chrome', 'firefox', 'safari', 'ios'].includes(fingerprint)) {
      return true;
    }
    if (alpn === 'h2' && fingerprint === 'android') {
      return true;
    }
  }
  return false;
}

// Build one share link for one (inbound row x ALPN x fingerprint)
// combo. Returns null if externalHost is unknown or the combo is broken.
// `ipv6` only affects the remark -- same host/port/credentials either
// way (the panel has no separate IPv6 address to connect to).
function buildOneLink({ inbound, externalHost, alpn, fingerprint, ipv6 = false }) {
  if (!externalHost) return null;

  if (isBrokenCombo(inbound.transport, alpn, fingerprint)) return null;

  const remark = remarkFor(inbound, alpn, fingerprint, ipv6);

  const params = buildTransportParams(inbound, alpn, fingerprint, externalHost).toString();
  const encodedRemark = encodeURIComponent(remark);

  if (inbound.protocol === 'vless') {
    return `vless://${inbound.client_uuid}@${externalHost}:${EXTERNAL_PORT}?${params}#${encodedRemark}`;
  }
  if (inbound.protocol === 'trojan') {
    return `trojan://${inbound.trojan_password}@${externalHost}:${EXTERNAL_PORT}?${params}#${encodedRemark}`;
  }
  return null;
}

// Every link variant for one inbound row (one per ALPN x fingerprint
// combo, doubled to also include an "- IPv6" variant of each when
// ipv6Enabled -- see modes.js's getIpv6Enabled()). alpnValues/
// fingerprints default to every variant; callers normally pass the
// admin's currently-enabled subsets (modes.js).
function buildLinksForInbound({ inbound, externalHost, alpnValues = ALPN_VARIANTS, fingerprints = FINGERPRINTS, ipv6Enabled = false }) {
  if (!externalHost) return [];

  const links = [];
  for (const alpn of alpnValues) {
    for (const fingerprint of fingerprints) {
      const link = buildOneLink({ inbound, externalHost, alpn, fingerprint });
      if (link) links.push(link);
      if (ipv6Enabled) {
        const ipv6Link = buildOneLink({ inbound, externalHost, alpn, fingerprint, ipv6: true });
        if (ipv6Link) links.push(ipv6Link);
      }
    }
  }
  return links;
}

// Every link variant for every inbound row -- the full subscription content.
function buildAllClientLinks(inboundRows, externalHost, alpnValues = ALPN_VARIANTS, fingerprints = FINGERPRINTS, ipv6Enabled = false) {
  return inboundRows.flatMap((inbound) => buildLinksForInbound({ inbound, externalHost, alpnValues, fingerprints, ipv6Enabled }));
}

// Non-functional "informational" entry for the raw subscription feed
// only, so a client app's server list shows days-left/usage-left
// directly. Points at 127.0.0.1:443 (never meant to be connected to)
// with a fixed all-zero dummy UUID.
function buildUsageInfoLink(remark) {
  const params = new URLSearchParams({ encryption: 'none', security: 'none', type: 'tcp' });
  return `vless://00000000-0000-0000-0000-000000000000@127.0.0.1:443?${params}#${encodeURIComponent(remark)}`;
}

module.exports = { buildAllClientLinks, buildLinksForInbound, buildUsageInfoLink, labelForInbound };
