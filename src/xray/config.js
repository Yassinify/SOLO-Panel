// Builds an Xray-core JSON config from `inbounds` DB rows. Each
// inbound listens on an internal 127.0.0.1 port with security: none
// -- Railway's edge terminates TLS; xray/proxy.js routes matching
// requests on the single public port to the right internal port.
// Pure functions only -- no DB access, no process spawning.
'use strict';

const INTERNAL_PORT_BASE = 10000;

// Fixed internal loopback port for Xray's Stats API, below
// INTERNAL_PORT_BASE so it never collides with a per-inbound port.
const STATS_API_PORT = 10085;

function internalPortForInbound(inboundId) {
  return INTERNAL_PORT_BASE + inboundId;
}

function statsTagForClient(inboundId) {
  return `client-${inboundId}`;
}

// Build a single Xray inbound object from one `inbounds` row. Always
// binds 127.0.0.1 -- only reached via xray/proxy.js's request proxy.
function buildInbound(inboundRow) {
  const streamSettings = { network: inboundRow.transport, security: 'none' };
  if (inboundRow.transport === 'ws') {
    streamSettings.wsSettings = { path: inboundRow.path };
  } else if (inboundRow.transport === 'xhttp') {
    // 'auto' lets Xray pick GET (stream-down) vs POST (stream-up) per-request.
    streamSettings.xhttpSettings = { path: inboundRow.path, mode: 'auto' };
  } else if (inboundRow.transport === 'httpupgrade') {
    streamSettings.httpupgradeSettings = { path: inboundRow.path };
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

// Build the full Xray config object. `inboundRows` are always all active.
function buildXrayConfig(inboundRows) {
  return {
    log: { loglevel: 'warning' },
    // Stats API: per-client/per-inbound traffic counters over gRPC on
    // an internal loopback port, queried via `xray api statsquery`
    // (see xray/stats.js).
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
