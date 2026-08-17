// Builds an Xray-core JSON config from `inbounds` DB rows. Every
// inbound is VLESS + REALITY (see docs/how-program-work.md): xray
// binds 0.0.0.0 on an internal port that the admin points a Railway
// TCP Proxy at, and REALITY handles TLS itself by borrowing a real
// site's certificate identity — no Railway-side TLS termination and
// no certificate of our own needed.
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
 * Build a single Xray inbound object from one `inbounds` row. Binds
 * 0.0.0.0 so Railway's TCP Proxy (a separate, manually-configured
 * feature — see docs/how-program-work.md) can reach it directly on
 * this internal port.
 */
function buildInbound(inboundRow) {
  const alpn = inboundRow.alpn.split(',').map((s) => s.trim()).filter(Boolean);

  const streamSettings = {
    network: inboundRow.transport, // 'tcp' or 'grpc'
    security: 'reality',
    realitySettings: {
      show: false,
      dest: inboundRow.reality_dest,
      xver: 0,
      serverNames: [inboundRow.reality_server_name],
      privateKey: inboundRow.reality_private_key,
      shortIds: [inboundRow.reality_short_id],
      alpn,
    },
  };
  if (inboundRow.transport === 'grpc') {
    streamSettings.grpcSettings = { serviceName: inboundRow.grpc_service_name };
  } else if (inboundRow.transport === 'xhttp') {
    // 'auto' lets Xray pick GET (stream-down) vs POST (stream-up)
    // per-request; the broadest-compatibility mode for XHTTP+REALITY.
    streamSettings.xhttpSettings = { path: inboundRow.xhttp_path, mode: 'auto' };
  }

  const client = {
    id: inboundRow.client_uuid,
    email: statsTagForClient(inboundRow.id),
  };
  // XTLS Vision flow only applies to raw tcp, not grpc/xhttp.
  if (inboundRow.transport === 'tcp') {
    client.flow = 'xtls-rprx-vision';
  }

  return {
    tag: `inbound-${inboundRow.id}`,
    listen: '0.0.0.0',
    port: internalPortForInbound(inboundRow.id),
    protocol: 'vless',
    settings: { clients: [client], decryption: 'none' },
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
