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

// Shadowsocks has no official way to carry transport/TLS info in
// query params the way vless/trojan do — real SS clients (Shadowrocket,
// Clash, NekoBox, etc.) expect it wrapped inside a single `plugin=`
// value understood by v2ray-plugin instead. That plugin only
// implements a websocket+TLS transport, so xhttp/httpupgrade rows
// still produce a link, but only the `ws` transport is actually
// usable by standard SS clients today.
function buildShadowsocksPluginOpts(inbound, host) {
  return ['v2ray-plugin', 'tls', `host=${host}`, `path=${inbound.path}`, 'mux=0'].join(';');
}

// Shadowsocks link for one inbound row. Unlike vless/trojan/vmess,
// there's no ALPN/fingerprint fan-out here: those are TLS ClientHello
// hints consumed by xray-core's own transports, not by v2ray-plugin,
// so varying them would just produce identical duplicate links.
function buildShadowsocksLink(inbound, host) {
  const userInfo = Buffer.from(`${inbound.ss_method}:${inbound.ss_password}`).toString('base64');
  const flag = regionFlag();
  const prefix = flag ? `${flag} ` : '';
  const remark = `${prefix}${inbound.protocol.toUpperCase()} - ${inbound.transport.toUpperCase()}`;
  const params = new URLSearchParams({ plugin: buildShadowsocksPluginOpts(inbound, host) });
  return `ss://${userInfo}@${host}:${EXTERNAL_PORT}?${params}#${encodeURIComponent(remark)}`;
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
  return null;
}

/**
 * Every link variant for one inbound row: one (ALPN x fingerprint)
 * link per combination for vless/trojan/vmess, or a single plugin-
 * based link for shadowsocks (see buildShadowsocksLink).
 *
 * `alpnValues`/`fingerprints` default to every variant, but callers
 * pass the admin's currently-enabled subsets (src/modes.js's
 * getEnabledAlpnValues()/getEnabledFingerprints()) so a disabled ALPN
 * or fingerprint mode stops being offered anywhere links get built.
 */
function buildLinksForInbound({ inbound, externalHost, alpnValues = ALPN_VARIANTS, fingerprints = FINGERPRINTS }) {
  if (!externalHost) return [];

  if (inbound.protocol === 'shadowsocks') {
    return [buildShadowsocksLink(inbound, externalHost)];
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
