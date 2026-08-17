// Builds client-facing share links (vless://, vmess://, trojan://,
// ss://) from an inbound + client DB row.
//
// Important asymmetry: internally, xray-core's own streamSettings use
// security "none" (see docs/how-program-work.md) because Railway
// terminates TLS at its edge before traffic ever reaches our process.
// But the LINK we hand to the end user's client app must still say
// security=tls, because from the client's point of view it really is
// making a real TLS connection (to Railway's edge, with a valid
// Let's Encrypt cert). Host/port in the link are always the public
// Railway domain on 443, never the internal loopback port.
'use strict';

function buildClientLink({ inbound, client, publicHost }) {
  const streamSettings = JSON.parse(inbound.config_json);
  const wsPath = (streamSettings.wsSettings && streamSettings.wsSettings.path) || '/';
  const remark = encodeURIComponent(`${inbound.remark}-${client.email}`);

  const isTcp = inbound.transport === 'tcp';
  if (isTcp && (!inbound.external_host || !inbound.external_port)) {
    return 'tcp-transport: set external host/port on this inbound first';
  }

  const host = isTcp ? inbound.external_host : publicHost;
  const port = isTcp ? inbound.external_port : 443;
  // 'tcp' inbounds have no TLS termination anywhere in the path (see
  // xray/config.js) — the link must honestly say security=none.
  // 'ws' inbounds are always fronted by Railway's edge TLS.
  const security = isTcp ? 'none' : 'tls';

  switch (inbound.protocol) {
    case 'vless': {
      const query = isTcp
        ? `type=tcp&security=none`
        : `type=ws&security=${security}&path=${encodeURIComponent(wsPath)}&host=${host}&sni=${host}`;
      return `vless://${client.client_uuid}@${host}:${port}?${query}#${remark}`;
    }
    case 'trojan': {
      const query = isTcp
        ? `type=tcp&security=none`
        : `type=ws&security=${security}&path=${encodeURIComponent(wsPath)}&host=${host}&sni=${host}`;
      return `trojan://${client.client_uuid}@${host}:${port}?${query}#${remark}`;
    }
    case 'vmess': {
      const vmessObj = {
        v: '2',
        ps: `${inbound.remark}-${client.email}`,
        add: host,
        port: String(port),
        id: client.client_uuid,
        aid: '0',
        scy: 'auto',
        net: isTcp ? 'tcp' : 'ws',
        type: 'none',
        host: isTcp ? '' : host,
        path: isTcp ? '' : wsPath,
        tls: security,
        sni: isTcp ? '' : host,
      };
      return `vmess://${Buffer.from(JSON.stringify(vmessObj)).toString('base64')}`;
    }
    case 'shadowsocks': {
      const userInfo = Buffer.from(`chacha20-ietf-poly1305:${client.client_uuid}`).toString(
        'base64'
      );
      if (isTcp) {
        // Plain Shadowsocks over raw TCP, no plugin needed.
        return `ss://${userInfo}@${host}:${port}#${remark}`;
      }
      // Requires a v2ray-plugin-capable client for the ws+tls transport.
      const plugin = encodeURIComponent(`v2ray-plugin;tls;host=${host};path=${wsPath}`);
      return `ss://${userInfo}@${host}:${port}?plugin=${plugin}#${remark}`;
    }
    default:
      throw new Error(`Unsupported protocol: ${inbound.protocol}`);
  }
}

module.exports = { buildClientLink };
