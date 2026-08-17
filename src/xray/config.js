// Builds an Xray-core JSON config from `inbounds` / `inbound_clients`
// DB rows. Pure functions only — no DB access, no process spawning.
// See docs/how-program-work.md for the single-port-sharing design:
// each inbound listens on 127.0.0.1:(10000 + inbound.id), never
// exposed directly; a future proxy layer forwards matching WS paths
// from the public Railway port to these internal ports.
'use strict';

const INTERNAL_PORT_BASE = 10000;

// Fixed internal loopback port for Xray's Stats API (dokodemo-door +
// gRPC/API service). Chosen well below INTERNAL_PORT_BASE so it never
// collides with a per-inbound port (10000 + inbound.id).
const STATS_API_PORT = 10085;

function internalPortForInbound(inboundId) {
  return INTERNAL_PORT_BASE + inboundId;
}

/**
 * Map enabled client rows into the protocol-specific client entry
 * shape Xray expects under inbound.settings.clients.
 */
function buildClientEntries(protocol, clientRows) {
  const enabledClients = clientRows.filter((c) => c.enabled);

  // The `email` field sent to Xray is only used internally as the
  // Stats API grouping key (see src/xray/stats.js) — it is never shown
  // to end users. We use the DB row id rather than the human-entered
  // `email` column so it's guaranteed unique across all inbounds/
  // clients even if two clients share a display email.
  switch (protocol) {
    case 'vless':
    case 'vmess':
      return enabledClients.map((c) => ({
        id: c.client_uuid,
        email: statsTagForClient(c.id),
      }));
    case 'trojan':
      return enabledClients.map((c) => ({
        password: c.client_uuid,
        email: statsTagForClient(c.id),
      }));
    case 'shadowsocks':
      return enabledClients.map((c) => ({
        method: 'chacha20-ietf-poly1305',
        password: c.client_uuid,
        email: statsTagForClient(c.id),
      }));
    default:
      throw new Error(`Unsupported protocol: ${protocol}`);
  }
}

function statsTagForClient(clientId) {
  return `client-${clientId}`;
}

/**
 * Build a single Xray inbound object from one `inbounds` row and its
 * related `inbound_clients` rows.
 *
 * Transport determines the bind address:
 * - 'ws' (default): loopback-only (127.0.0.1). Never reachable
 *   directly; the WS proxy in xray/proxy.js forwards matching paths
 *   from Railway's single public HTTP port to this internal port.
 * - 'tcp': binds 0.0.0.0 so Railway's TCP Proxy (a separate,
 *   manually-configured feature — see docs/how-program-work.md) can
 *   reach it directly on this internal port.
 */
function buildInbound(inboundRow, clientRows) {
  const streamSettings = JSON.parse(inboundRow.config_json);

  const settings = { clients: buildClientEntries(inboundRow.protocol, clientRows) };
  if (inboundRow.protocol === 'vless') {
    settings.decryption = 'none';
  }

  return {
    tag: `inbound-${inboundRow.id}`,
    listen: inboundRow.transport === 'tcp' ? '0.0.0.0' : '127.0.0.1',
    port: internalPortForInbound(inboundRow.id),
    protocol: inboundRow.protocol,
    settings,
    streamSettings,
  };
}

/**
 * Build the full Xray config object.
 * @param {Array} inboundRows - rows from the `inbounds` table (enabled ones only, caller filters).
 * @param {Map<number, Array>} clientsByInboundId - inbound_id -> array of inbound_clients rows.
 */
function buildXrayConfig(inboundRows, clientsByInboundId) {
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
      ...inboundRows.map((row) =>
        buildInbound(row, clientsByInboundId.get(row.id) || [])
      ),
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
