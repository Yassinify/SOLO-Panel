// Lets Xray's WS/XHTTP/HTTPUpgrade inbounds share Railway's single
// public port with the Express panel UI. Railway forwards everything
// on 0.0.0.0:$PORT to this one process, so this module inspects each
// incoming request's path against the generated inbounds' `path`
// column and forwards matching traffic to that inbound's internal
// 127.0.0.1 port; everything else falls through to Express.
'use strict';

const http = require('http');
const net = require('net');

/**
 * @param {import('http').Server} server - the Express app's HTTP server.
 * @param {() => Array} listInbounds - returns current inbound rows
 *   (called per-request so newly generated inbounds are picked up
 *   without restarting the proxy).
 * @param {(id: number) => number} internalPortForInbound
 */
function attachProxy(server, listInbounds, internalPortForInbound) {
  function findInboundForPath(path) {
    return listInbounds().find((row) => row.path === path && row.transport !== 'xhttp')
      || null;
  }

  function findXhttpInboundForPath(path) {
    return listInbounds().find((row) => row.path === path && row.transport === 'xhttp')
      || null;
  }

  // WS and HTTPUpgrade both perform an HTTP `Upgrade` handshake, so
  // both are handled the same way: hand the raw TCP socket off to the
  // matching internal xray-core inbound, replaying the original
  // request line/headers first since we already consumed them.
  server.on('upgrade', (req, clientSocket, head) => {
    const path = req.url.split('?')[0];
    const inbound = findInboundForPath(path);
    if (!inbound) {
      clientSocket.destroy();
      return;
    }

    const upstream = net.connect(internalPortForInbound(inbound.id), '127.0.0.1', () => {
      const rawHeaders = req.rawHeaders
        .reduce((lines, val, i) => {
          if (i % 2 === 0) lines.push(`${val}: ${req.rawHeaders[i + 1]}`);
          return lines;
        }, [])
        .join('\r\n');
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${rawHeaders}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });

  // XHTTP is plain HTTP (GET/POST/PUT, no Upgrade header), so it's
  // handled as an ordinary reverse-proxy step ahead of Express's own
  // routes. Must run before express.static/session/etc. in server.js.
  return function xhttpMiddleware(req, res, next) {
    const path = req.url.split('?')[0];
    const inbound = findXhttpInboundForPath(path);
    if (!inbound) return next();

    const upstreamReq = http.request(
      {
        host: '127.0.0.1',
        port: internalPortForInbound(inbound.id),
        method: req.method,
        path: req.url,
        headers: req.headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );
    upstreamReq.on('error', () => res.destroy());
    req.pipe(upstreamReq);
  };
}

module.exports = { attachProxy };
