// Builds a sing-box JSON config from `inbounds` DB rows whose
// core === 'singbox'. Schema verified against the official docs
// (sing-box.sagernet.org/configuration/inbound/{vless,vmess,trojan}
// and .../shared/v2ray-transport) rather than assumed from Xray's
// shape, since sing-box's config format is its own, not
// Xray-compatible.
//
// Scope: sing-box here only ever serves vless/vmess/trojan over
// ws/httpupgrade transport (the two V2Ray-transport types Railway's
// HTTP-upgrade edge can forward). Shadowsocks is intentionally NOT
// generated for the sing-box core: sing-box's shadowsocks inbound has
// no `transport` field at all (raw TCP/UDP only), which doesn't fit
// this project's one-Railway-port constraint the way it does for
// Xray's shadowsocks-over-ws. Pure functions only, same pattern as
// xray/config.js - no DB access, no process spawning.
'use strict';

// Separate internal port range from Xray's (10000 + id, see
// xray/config.js) so both cores can run inbounds with the same
// `inbounds.id` without colliding on 127.0.0.1.
const INTERNAL_PORT_BASE = 20000;

function internalPortForInbound(inboundId) {
  return INTERNAL_PORT_BASE + inboundId;
}

/** Build a single sing-box `transport` object for a ws/httpupgrade row. */
function buildTransport(inboundRow) {
  if (inboundRow.transport === 'ws') {
    return { type: 'ws', path: inboundRow.path };
  }
  if (inboundRow.transport === 'httpupgrade') {
    return { type: 'httpupgrade', path: inboundRow.path };
  }
  throw new Error(`Unsupported sing-box transport: ${inboundRow.transport}`);
}

/** Build a single sing-box inbound object from one `inbounds` row. */
function buildInbound(inboundRow) {
  const base = {
    tag: `inbound-${inboundRow.id}`,
    listen: '127.0.0.1',
    listen_port: internalPortForInbound(inboundRow.id),
    transport: buildTransport(inboundRow),
  };

  if (inboundRow.protocol === 'vless') {
    return { type: 'vless', ...base, users: [{ uuid: inboundRow.client_uuid }] };
  }
  if (inboundRow.protocol === 'vmess') {
    // alterId: 0 disables VMess's legacy MD5 auth mode (recommended;
    // matches the AEAD-only mode Xray also uses for generated vmess).
    return { type: 'vmess', ...base, users: [{ uuid: inboundRow.client_uuid, alterId: 0 }] };
  }
  if (inboundRow.protocol === 'trojan') {
    return { type: 'trojan', ...base, users: [{ password: inboundRow.trojan_password }] };
  }

  throw new Error(`Unsupported sing-box protocol: ${inboundRow.protocol}`);
}

/**
 * Build the full sing-box config object.
 * @param {Array} inboundRows - rows from the `inbounds` table with
 *   core === 'singbox' (callers filter before passing rows in).
 */
function buildSingboxConfig(inboundRows) {
  return {
    log: { level: 'warn', timestamp: true },
    inbounds: inboundRows.map((row) => buildInbound(row)),
    outbounds: [{ type: 'direct', tag: 'direct' }],
  };
}

module.exports = {
  buildSingboxConfig,
  internalPortForInbound,
};
