// Builds every client-facing share link for one `inbounds` DB row.
//
// TLS is terminated by Railway's edge, not xray-core (see
// docs/how-program-work.md), so every link uses `security=tls` on the
// single public port 443, and the ALPN/fingerprint values are purely
// client-side hints for the client's own outbound TLS handshake with
// that edge — they don't need to match anything xray-core is doing.
// That means a single inbound row (one protocol/transport pair, one
// set of credentials) fans out into one link per (ALPN x fingerprint)
// combination, all pointing at the exact same server/path/identity.
'use strict';

const { ALPN_VARIANTS, FINGERPRINTS } = require('../utils');

// Railway gives every service one HTTPS domain on the standard port;
// see docs/how-program-work.md for why other ports were ruled out.
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

// Per-link remark, e.g. "VLESS - 443 - WS - http/1.1 - Chrome".
function remarkFor(inbound, alpn, fingerprint) {
  const fpLabel = FINGERPRINT_LABELS[fingerprint] || fingerprint;
  return `${inbound.protocol.toUpperCase()} - ${EXTERNAL_PORT} - ${inbound.transport.toUpperCase()} - ${alpn} - ${fpLabel}`;
}

// Query params shared by vless/trojan/shadowsocks (vmess uses its own
// base64 JSON blob instead, see buildVmessLink below).
function buildTransportParams(inbound, alpn, fingerprint, host) {
  const params = new URLSearchParams({
    type: inbound.transport,
    security: 'tls',
    alpn,
    fp: fingerprint,
    sni: host,
    path: inbound.path,
    host,
  });
  if (inbound.transport === 'xhttp') {
    params.set('mode', 'auto');
  }
  return params;
}

function buildVmessLink(inbound, alpn, fingerprint, host, remark) {
  const payload = {
    v: '2',
    ps: remark,
    add: host,
    port: String(EXTERNAL_PORT),
    id: inbound.client_uuid,
    aid: '0',
    scy: 'auto',
    net: inbound.transport,
    type: 'none',
    host,
    path: inbound.path,
    tls: 'tls',
    sni: host,
    alpn,
    fp: fingerprint,
  };
  return `vmess://${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
}

/**
 * Build one share link for one (inbound row x ALPN x fingerprint)
 * combination. Returns null if `externalHost` isn't known yet (should
 * not normally happen — Railway always provides a domain).
 */
function buildOneLink({ inbound, externalHost, alpn, fingerprint }) {
  if (!externalHost) return null;

  const remark = remarkFor(inbound, alpn, fingerprint);

  if (inbound.protocol === 'vmess') {
    return buildVmessLink(inbound, alpn, fingerprint, externalHost, remark);
  }

  const params = buildTransportParams(inbound, alpn, fingerprint, externalHost);
  const encodedRemark = encodeURIComponent(remark);

  if (inbound.protocol === 'vless') {
    return `vless://${inbound.client_uuid}@${externalHost}:${EXTERNAL_PORT}?${params}#${encodedRemark}`;
  }
  if (inbound.protocol === 'trojan') {
    return `trojan://${inbound.trojan_password}@${externalHost}:${EXTERNAL_PORT}?${params}#${encodedRemark}`;
  }
  if (inbound.protocol === 'shadowsocks') {
    const userInfo = Buffer.from(`${inbound.ss_method}:${inbound.ss_password}`).toString('base64');
    return `ss://${userInfo}@${externalHost}:${EXTERNAL_PORT}?${params}#${encodedRemark}`;
  }
  return null;
}

/** Every (ALPN x fingerprint) link variant for one inbound row. */
function buildLinksForInbound({ inbound, externalHost }) {
  const links = [];
  for (const alpn of ALPN_VARIANTS) {
    for (const fingerprint of FINGERPRINTS) {
      const link = buildOneLink({ inbound, externalHost, alpn, fingerprint });
      if (link) links.push(link);
    }
  }
  return links;
}

/** Every link variant for every inbound row — the full subscription content. */
function buildAllClientLinks(inboundRows, externalHost) {
  return inboundRows.flatMap((inbound) => buildLinksForInbound({ inbound, externalHost }));
}

module.exports = { buildAllClientLinks, buildLinksForInbound, labelForInbound, EXTERNAL_PORT };
