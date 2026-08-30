// Builds an Xray-core JSON config from `inbounds` DB rows. Every
// inbound is one (protocol x transport) combo (see
// docs/how-program-work.md) listening on an internal 127.0.0.1 port
// with `security: none` — Railway's edge terminates TLS for us and
// forwards plain HTTP, and `src/xray/proxy.js` routes matching
// WS/XHTTP/HTTPUpgrade requests on Railway's single public port to
// the right internal port by path.
// Pure functions only — no DB access, no process spawning.
'use strict';

const INTERNAL_PORT_BASE = 10000;

// Fixed internal loopback port for Xray's Stats API (dokodemo-door +
// gRPC/API service). Chosen well below INTERNAL_PORT_BASE so it never
// collides with a per-inbound port (10000 + inbound.id).
const STATS_API_PORT = 10085;

function internalPortForInbound(inboundId) {
  return INTERNAL_PORT_BASE + inboundId;
}

function statsTagForClient(inboundId) {
  return `client-${inboundId}`;
}

/**
 * Build a single Xray inbound object from one `inbounds` row. Always
 * binds 127.0.0.1 — never reached directly, only via the internal
 * request proxy in `src/xray/proxy.js` (see module header above).
 */
function buildInbound(inboundRow) {
  const streamSettings = { network: inboundRow.transport, security: 'none' };
  if (inboundRow.transport === 'ws') {
    streamSettings.wsSettings = { path: inboundRow.path };
  } else if (inboundRow.transport === 'xhttp') {
    // 'auto' lets Xray pick GET (stream-down) vs POST (stream-up) per-request.
    streamSettings.xhttpSettings = { path: inboundRow.path, mode: 'auto' };
  } else if (inboundRow.transport === 'httpupgrade') {
    streamSettings.httpupgradeSettings = { path: inboundRow.path };
  } else if (inboundRow.transport === 'raw') {
    // Plain TCP disguised as an HTTP request (header.type: 'http') so it
    // looks like ordinary traffic on the wire; src/xray/proxy.js hijacks
    // the raw socket for matching requests instead of buffering them like
    // xhttp, since after this fake header the stream is full-duplex raw
    // bytes, not request/response HTTP. `request.path` is matched
    // literally against what the client sends, so it's kept in sync with
    // the generated path's pathname (query string dropped — Xray's own
    // header check only looks at the path segment).
    streamSettings.rawSettings = {
      header: {
        type: 'http',
        request: {
          path: [inboundRow.path.split('?')[0]],
          ...(process.env.RAILWAY_PUBLIC_DOMAIN
            ? { headers: { Host: [process.env.RAILWAY_PUBLIC_DOMAIN] } }
            : {}),
        },
      },
    };
  }

  const protocol = inboundRow.protocol;
  let settings;
  const email = statsTagForClient(inboundRow.id);

  if (protocol === 'vless') {
    settings = { clients: [{ id: inboundRow.client_uuid, email }], decryption: 'none' };
  } else if (protocol === 'trojan') {
    settings = { clients: [{ password: inboundRow.trojan_password, email }] };
  }

  return {
    tag: `inbound-${inboundRow.id}`,
    listen: '127.0.0.1',
    port: internalPortForInbound(inboundRow.id),
    protocol,
    settings,
    streamSettings,
  };
}

/**
 * Build the full Xray config object.
 * @param {Array} inboundRows - rows from the `inbounds` table (all
 *   rows are always active — there is no enabled/disabled flag).
 */
function buildXrayConfig(inboundRows) {
  return {
    log: { loglevel: 'warning' },
    // Stats API: exposes per-client/per-inbound traffic counters over
    // gRPC on an internal-only loopback port. Queried via the `xray
    // api statsquery` CLI subcommand (see src/xray/stats.js) — no
    // separate gRPC client library needed in Node.
    api: {
      tag: 'api',
      services: ['StatsService'],
    },
    stats: {},
    policy: {
      levels: { '0': { statsUserUplink: true, statsUserDownlink: true } },
      system: { statsInboundUplink: true, statsInboundDownlink: true },
    },
    inbounds: [
      {
        tag: 'api',
        listen: '127.0.0.1',
        port: STATS_API_PORT,
        protocol: 'dokodemo-door',
        settings: { address: '127.0.0.1' },
      },
      ...inboundRows.map((row) => buildInbound(row)),
    ],
    routing: {
      rules: [{ type: 'field', inboundTag: ['api'], outboundTag: 'api' }],
    },
    outbounds: [
      { protocol: 'freedom', tag: 'direct' },
      { protocol: 'blackhole', tag: 'block' },
      { protocol: 'freedom', tag: 'api' },
    ],
  };
}

module.exports = {
  buildXrayConfig,
  internalPortForInbound,
  STATS_API_PORT,
  statsTagForClient,
};
