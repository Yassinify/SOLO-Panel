// Builds every client-facing share link for one `inbounds` DB row.
// TLS is terminated by Railway's edge, not xray-core, so every link
// uses security=tls on the public port 443 -- ALPN/fingerprint are
// client-side hints only, they don't need to match xray-core config.
// One inbound row fans out into one link per (ALPN x fingerprint) combo.
'use strict';

const { ALPN_VARIANTS, FINGERPRINTS, regionFlag } = require('../utils');

// Railway gives every service one HTTPS domain on the standard port.
const EXTERNAL_PORT = 443;

// `raw` doesn't go through Railway's shared HTTPS domain -- that edge
// is an HTTP/TLS reverse proxy, not a raw passthrough, and silently
// drops non-HTTP traffic (confirmed by testing -- see docs/problem.md).
// It needs a dedicated Railway TCP Proxy port instead (true raw
// passthrough, no TLS termination), which Railway exposes via these
// two env vars once the admin enables TCP Proxy in the dashboard and
// points it at server.js's RAW_TCP_PORT listener.
function rawTcpProxyTarget() {
  const host = process.env.RAILWAY_TCP_PROXY_DOMAIN;
  const port = process.env.RAILWAY_TCP_PROXY_PORT;
  return host && port ? { host, port } : null;
}

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
// `raw` has no ALPN/fingerprint (no TLS involved -- see
// rawTcpProxyTarget() above), so its remark omits both.
function remarkFor(inbound, alpn, fingerprint) {
  const flag = regionFlag();
  const prefix = flag ? `${flag} ` : '';
  if (inbound.transport === 'raw') {
    return `${prefix}${inbound.protocol.toUpperCase()} - RAW`;
  }
  const fpLabel = FINGERPRINT_LABELS[fingerprint] || fingerprint;
  return `${prefix}${inbound.protocol.toUpperCase()} - ${inbound.transport.toUpperCase()} - ${alpn} - ${fpLabel}`;
}

// Query params shared by vless/trojan. Only called for TLS-based
// transports (ws/xhttp/httpupgrade) -- `raw` builds its own params
// directly in buildOneLink() since it has no TLS/ALPN/fingerprint.
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
// `raw` ignores alpn/fingerprint entirely (see rawTcpProxyTarget()).
function buildOneLink({ inbound, externalHost, alpn, fingerprint }) {
  if (!externalHost) return null;

  if (inbound.transport === 'raw') {
    const target = rawTcpProxyTarget();
    if (!target) return null; // Railway TCP Proxy not enabled/configured yet

    const remark = remarkFor(inbound, null, null);
    const encodedRemark = encodeURIComponent(remark);
    const paramsObj = inbound.protocol === 'vless' ? { encryption: 'none' } : {};
    Object.assign(paramsObj, {
      type: 'tcp', // client apps' link parsers still expect the pre-rename "tcp" value here
      security: 'none', // Railway's TCP Proxy does not terminate TLS -- see rawTcpProxyTarget()
      headerType: 'http', // tells the client to send the camouflage request xray/proxy.js sniffs for
      host: externalHost, // camouflage Host header only, not the actual connect target
      path: inbound.path,
    });
    const params = new URLSearchParams(paramsObj).toString();

    if (inbound.protocol === 'vless') {
      return `vless://${inbound.client_uuid}@${target.host}:${target.port}?${params}#${encodedRemark}`;
    }
    if (inbound.protocol === 'trojan') {
      return `trojan://${inbound.trojan_password}@${target.host}:${target.port}?${params}#${encodedRemark}`;
    }
    return null;
  }

  if (isBrokenCombo(inbound.transport, alpn, fingerprint)) return null;

  const remark = remarkFor(inbound, alpn, fingerprint);

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
// `raw` has no ALPN/fingerprint concept (no TLS -- see
// rawTcpProxyTarget()), so it always produces exactly one link,
// ignoring alpnValues/fingerprints entirely.
function buildLinksForInbound({ inbound, externalHost, alpnValues = ALPN_VARIANTS, fingerprints = FINGERPRINTS }) {
  if (!externalHost) return [];

  if (inbound.transport === 'raw') {
    const link = buildOneLink({ inbound, externalHost, alpn: null, fingerprint: null });
    return link ? [link] : [];
  }

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
function buildAllClientLinks(inboundRows, externalHost, alpnValues = ALPN_VARIANTS, fingerprints = FINGERPRINTS) {
  return inboundRows.flatMap((inbound) => buildLinksForInbound({ inbound, externalHost, alpnValues, fingerprints }));
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
