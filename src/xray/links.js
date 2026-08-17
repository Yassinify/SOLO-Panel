// Builds the client-facing VLESS+REALITY share link (vless://) from
// an inbound DB row (which now also holds its one client's fields).
//
// Unlike the old WS setup, REALITY handles its own TLS — xray-core
// itself performs the real TLS handshake by borrowing the target
// site's certificate identity (reality_dest/reality_server_name), so
// there is no Railway-edge-vs-internal asymmetry to account for here:
// the link's security/fingerprint/ALPN describe exactly what xray-core
// is doing. Host/port in the link are always the Railway TCP Proxy's
// assigned external host/port, never the internal loopback port. The
// host is shared across every inbound (one Railway service = one TCP
// Proxy host), so it's passed in separately rather than read off the
// inbound row — see `inbounds.js#getExternalHost`.
'use strict';

// There's no admin-entered name anymore (see docs/how-program-work.md
// — inbounds are auto-generated, one per transport/ALPN combo), so
// the share-link's remark is derived straight from those two fields,
// e.g. "TCP (h2, http/1.1)".
function labelForInbound(inbound) {
  return `${inbound.transport.toUpperCase()} (${inbound.alpn})`;
}

function buildClientLink({ inbound, externalHost }) {
  if (!externalHost || !inbound.external_port) {
    return null;
  }

  const remark = encodeURIComponent(labelForInbound(inbound));
  const params = new URLSearchParams({
    type: inbound.transport,
    security: 'reality',
    pbk: inbound.reality_public_key,
    fp: inbound.fingerprint,
    sni: inbound.reality_server_name,
    sid: inbound.reality_short_id,
    alpn: inbound.alpn,
  });
  if (inbound.transport === 'tcp') {
    params.set('flow', 'xtls-rprx-vision');
  } else if (inbound.transport === 'grpc') {
    params.set('serviceName', inbound.grpc_service_name);
    params.set('mode', 'gun');
  } else if (inbound.transport === 'xhttp') {
    params.set('path', inbound.xhttp_path);
    params.set('mode', 'auto');
  }

  return `vless://${inbound.client_uuid}@${externalHost}:${inbound.external_port}?${params.toString()}#${remark}`;
}

module.exports = { buildClientLink, labelForInbound };
