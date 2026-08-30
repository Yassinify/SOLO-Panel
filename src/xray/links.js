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

const { ALPN_VARIANTS, FINGERPRINTS, regionFlag } = require('../utils');

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

// Per-link remark, e.g. "\ud83c\uddfa\ud83c\uddf8 VLESS - WS - http/1.1 - Chrome". Ports are
// never included — every generated link always uses the fixed
// EXTERNAL_PORT (443), so it'd be redundant. Prefixed with the
// deployment's Railway-region country flag when known (see
// utils.js's regionFlag()).
function remarkFor(inbound, alpn, fingerprint) {
  const fpLabel = FINGERPRINT_LABELS[fingerprint] || fingerprint;
  const flag = regionFlag();
  const prefix = flag ? `${flag} ` : '';
  return `${prefix}${inbound.protocol.toUpperCase()} - ${inbound.transport.toUpperCase()} - ${alpn} - ${fpLabel}`;
}

// Query params shared by vless/trojan (vmess uses its own base64 JSON
// blob, and shadowsocks uses a `plugin=` value — see buildVmessLink /
// buildShadowsocksLink below).
function buildTransportParams(inbound, alpn, fingerprint, host) {
  // Client apps' share-link parsers use the pre-rename "tcp" as the
  // `type` value for this transport, not Xray-core's own JSON-config
  // alias "raw" (Xray-core v24.9.30+ renamed the "tcp" transport to
  // "raw" server-side, but that rename was never carried into the
  // client-facing URI convention -- every real-world example link
  // still uses type=tcp). See docs/problem.md for the research trail.
  const linkTransportType = inbound.transport === 'raw' ? 'tcp' : inbound.transport;
  const params = new URLSearchParams({
    type: linkTransportType,
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
  if (inbound.transport === 'raw') {
    // Tells the client to send the fake HTTP request line/headers
    // camouflage matching xray/config.js's rawSettings.header.type
    // 'http' -- without this the client defaults to no HTTP
    // camouflage and never sends the request line src/xray/proxy.js's
    // handleConnection() sniffs for, so the connection never matches
    // any inbound server-side.
    params.set('headerType', 'http');
  }
  return params;
}

/**
 * Build one share link for one (inbound row x ALPN x fingerprint)
 * combination. Returns null if `externalHost` isn't known yet (should
 * not normally happen — Railway always provides a domain).
 */
function buildOneLink({ inbound, externalHost, alpn, fingerprint }) {
  if (!externalHost) return null;

  const remark = remarkFor(inbound, alpn, fingerprint);

  const params = buildTransportParams(inbound, alpn, fingerprint, externalHost);
  const encodedRemark = encodeURIComponent(remark);

  if (inbound.protocol === 'vless') {
    return `vless://${inbound.client_uuid}@${externalHost}:${EXTERNAL_PORT}?${params}#${encodedRemark}`;
  }
  if (inbound.protocol === 'trojan') {
    return `trojan://${inbound.trojan_password}@${externalHost}:${EXTERNAL_PORT}?${params}#${encodedRemark}`;
  }
  return null;
}

/**
 * Build a REALITY share link. Unlike every other transport, REALITY
 * doesn't point at Railway's shared 443 -- it needs its own
 * separately-exposed port (see xray/config.js's header), so `host`/
 * `port` come from the admin-entered `reality_external_address`
 * column (Railway TCP Proxy's assigned address), not `externalHost`/
 * `EXTERNAL_PORT`. Fingerprint is still a real lever here (unlike
 * every other transport's link-only `fp=`): xray-core itself performs
 * the real TLS handshake for a `reality` inbound, so the client's
 * uTLS ClientHello shape genuinely matters server-side. No ALPN fan-
 * out -- REALITY's own real TLS handshake negotiates that with the
 * client directly, it isn't a separate link-level hint to vary.
 */
function buildRealityLink(inbound, fingerprint, host, port, remark) {
  const params = new URLSearchParams({
    security: 'reality',
    encryption: 'none',
    pbk: inbound.reality_public_key,
    sid: inbound.reality_short_id,
    sni: inbound.reality_dest,
    fp: fingerprint,
    type: 'tcp',
  });
  return `vless://${inbound.client_uuid}@${host}:${port}?${params}#${encodeURIComponent(remark)}`;
}

/**
 * Every link variant for one inbound row: one (ALPN x fingerprint)
 * link per combination for vless/trojan, or one link per
 * fingerprint (no ALPN fan-out) for the REALITY row (see
 * buildRealityLink above).
 *
 * `alpnValues`/`fingerprints` default to every variant, but callers
 * pass the admin's currently-enabled subsets (src/modes.js's
 * getEnabledAlpnValues()/getEnabledFingerprints()) so a disabled ALPN
 * or fingerprint mode stops being offered anywhere links get built.
 */
function buildLinksForInbound({ inbound, externalHost, alpnValues = ALPN_VARIANTS, fingerprints = FINGERPRINTS }) {
  if (!externalHost) return [];

  if (inbound.transport === 'reality') {
    // Not configured yet (admin hasn't attached a Railway TCP Proxy
    // and saved its assigned address) -- no usable link to offer.
    if (!inbound.reality_external_address) return [];
    const separatorIndex = inbound.reality_external_address.lastIndexOf(':');
    if (separatorIndex === -1) return []; // malformed "host:port" value, fail safe rather than build a broken link
    const host = inbound.reality_external_address.slice(0, separatorIndex);
    const port = inbound.reality_external_address.slice(separatorIndex + 1);
    const flag = regionFlag();
    const prefix = flag ? `${flag} ` : '';
    return fingerprints.map((fingerprint) =>
      buildRealityLink(inbound, fingerprint, host, port, `${prefix}VLESS - REALITY - ${FINGERPRINT_LABELS[fingerprint] || fingerprint}`)
    );
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

/** Every link variant for every inbound row — the full subscription content. */
function buildAllClientLinks(inboundRows, externalHost, alpnValues = ALPN_VARIANTS, fingerprints = FINGERPRINTS) {
  return inboundRows.flatMap((inbound) => buildLinksForInbound({ inbound, externalHost, alpnValues, fingerprints }));
}

/**
 * A non-functional "informational" entry, included in the raw
 * subscription feed only (see server.js's sendRawSubscription()), so
 * a client app's own server list shows the current days-left/usage-
 * left figures directly -- without the user needing to open the
 * Subscription Web Panel. Deliberately points at the local loopback
 * address (127.0.0.1:443): this entry is never meant to actually be
 * connected to, only its remark carries meaning. Uses vless (the
 * simplest URI shape) with a fixed all-zero dummy UUID -- same one
 * for every deployment, since it's not tied to any real credential.
 */
function buildUsageInfoLink(remark) {
  const params = new URLSearchParams({ encryption: 'none', security: 'none', type: 'tcp' });
  return `vless://00000000-0000-0000-0000-000000000000@127.0.0.1:443?${params}#${encodeURIComponent(remark)}`;
}

module.exports = { buildAllClientLinks, buildLinksForInbound, buildUsageInfoLink, labelForInbound, EXTERNAL_PORT };
