// Builds every client-facing share link for one `inbounds` DB row.
// TLS is terminated by Railway's edge, not xray-core, so every link
// uses security=tls on the public port 443 -- ALPN/fingerprint are
// client-side hints only, they don't need to match xray-core config.
// One inbound row fans out into one link per (ALPN x fingerprint) combo.
'use strict';

const { ALPN_VARIANTS, FINGERPRINTS, regionFlag } = require('../utils');
const { labelForMode } = require('../modes');

// Railway gives every service one HTTPS domain on the standard port.
const EXTERNAL_PORT = 443;

// Grouping label for one DB row (used on the dashboard, which lists
// rows, not individual link variants).
function labelForInbound(inbound) {
  return `${inbound.protocol.toUpperCase()} / ${inbound.transport.toUpperCase()}`;
}

// Per-link remark, e.g. "🇺🇸 VLESS - WS - http/1.1 - Chrome". Port is
// never included -- every link uses the fixed EXTERNAL_PORT (443).
function remarkFor(inbound, alpn, fingerprint) {
  const flag = regionFlag();
  const prefix = flag ? `${flag} ` : '';
  const fpLabel = labelForMode('fingerprint', fingerprint);
  return `${prefix}${inbound.protocol.toUpperCase()} - ${inbound.transport.toUpperCase()} - ${alpn} - ${fpLabel}`;
}

// Simplified remark, e.g. flag + "VLESS - 01" -- "Advanced options"
// toggle (advancedOptions.js) on the dashboard. Hides transport/ALPN/
// fingerprint entirely; `number` is this link's position within its
// own protocol's sequence (assigned by buildAllClientLinks() below),
// zero-padded to `width` digits so client apps that sort server lists
// alphabetically still show them in the right order once there are
// 10+ variants ("01".. "10", not "1", "10", "2"...).
function simpleRemarkFor(inbound, number, width) {
  const flag = regionFlag();
  const prefix = flag ? `${flag} ` : '';
  return `${prefix}${inbound.protocol.toUpperCase()} - ${String(number).padStart(width, '0')}`;
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
//   - xhttp's browser fingerprints (chrome/firefox/safari/ios/android)
//     conflict with plain http/1.1 ALPN;
//   - xhttp's android fingerprint also conflicts with h2 ALPN;
//   - ws's android fingerprint conflicts with h2 ALPN (trojan/ws/h2/
//     android confirmed broken even though ws isn't xhttp).
// So the broken combination is never generated as a link anywhere.
function isBrokenCombo(transport, alpn, fingerprint) {
  if (transport === 'xhttp') {
    if (alpn === 'http/1.1' && ['chrome', 'firefox', 'safari', 'ios', 'android'].includes(fingerprint)) {
      return true;
    }
    if (alpn === 'h2' && fingerprint === 'android') {
      return true;
    }
  }
  if (transport === 'ws' && alpn === 'h2' && fingerprint === 'android') {
    return true;
  }
  return false;
}

// Build one share link for one (inbound row x ALPN x fingerprint)
// combo. Returns null if externalHost is unknown or the combo is broken.
function buildOneLink({ inbound, externalHost, alpn, fingerprint, remarkOverride }) {
  if (!externalHost) return null;

  if (isBrokenCombo(inbound.transport, alpn, fingerprint)) return null;

  const remark = remarkOverride || remarkFor(inbound, alpn, fingerprint);

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
// combo). alpnValues/fingerprints default to every variant; callers
// normally pass the admin's currently-enabled subsets (modes.js).
function buildLinksForInbound({ inbound, externalHost, alpnValues = ALPN_VARIANTS, fingerprints = FINGERPRINTS }) {
  if (!externalHost) return [];

  const links = [];
  for (const alpn of alpnValues) {
    for (const fingerprint of fingerprints) {
      const link = buildOneLink({ inbound, externalHost, alpn, fingerprint });
      if (link) links.push(link);
    }
  }
  return links;
}

// Every link variant for every inbound row -- the full subscription content.
// When `simpleRemarks` is true (advancedOptions.js's toggle), every link's
// remark is replaced with a short "<protocol> - <number>" form instead of
// the full descriptive one: the full ordered (inbound, alpn, fingerprint)
// combo list is built first (excluding broken combos), per-protocol totals
// are counted to pick each protocol's zero-pad width, then running numbers
// are assigned within that same order.
function buildAllClientLinks(inboundRows, externalHost, alpnValues = ALPN_VARIANTS, fingerprints = FINGERPRINTS, simpleRemarks = false) {
  if (!simpleRemarks) {
    return inboundRows.flatMap((inbound) => buildLinksForInbound({ inbound, externalHost, alpnValues, fingerprints }));
  }

  const combos = [];
  for (const inbound of inboundRows) {
    for (const alpn of alpnValues) {
      for (const fingerprint of fingerprints) {
        if (isBrokenCombo(inbound.transport, alpn, fingerprint)) continue;
        combos.push({ inbound, alpn, fingerprint });
      }
    }
  }

  const protocolTotals = {};
  for (const combo of combos) {
    protocolTotals[combo.inbound.protocol] = (protocolTotals[combo.inbound.protocol] || 0) + 1;
  }
  const protocolWidths = {};
  for (const [protocol, total] of Object.entries(protocolTotals)) {
    protocolWidths[protocol] = String(total).length;
  }

  const protocolCounters = {};
  const links = [];
  for (const combo of combos) {
    const protocol = combo.inbound.protocol;
    protocolCounters[protocol] = (protocolCounters[protocol] || 0) + 1;
    const remark = simpleRemarkFor(combo.inbound, protocolCounters[protocol], protocolWidths[protocol]);
    const link = buildOneLink({ inbound: combo.inbound, externalHost, alpn: combo.alpn, fingerprint: combo.fingerprint, remarkOverride: remark });
    if (link) links.push(link);
  }
  return links;
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
