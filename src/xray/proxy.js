// Lets Xray's WS/XHTTP/HTTPUpgrade inbounds share Railway's single
// public port with the Express panel UI. Everything is handed to the
// http.Server exactly as if it had accepted the connection itself:
// WS/HTTPUpgrade via the 'upgrade' event, XHTTP via `xhttpMiddleware`
// — both matched by path against the generated inbounds' `path` column.
'use strict';

const http = require('http');
const net = require('net');

/**
 * @param {import('http').Server} server - the Express app's HTTP server.
 * @param {() => Array} listInbounds - returns current inbound rows
 *   (called per-connection/request so newly generated inbounds are
 *   picked up without restarting the proxy).
 * @param {(row: object) => number} internalPortForRow - core-aware
 *   port lookup (see src/cores/ports.js); takes the whole inbound row,
 *   not just its id, since the port range depends on which core (xray
 *   vs sing-box) actually serves that row.
 */
function attachProxy(server, listInbounds, internalPortForRow) {
  function findInboundForPath(path) {
    return listInbounds().find((row) => row.path === path && row.transport !== 'xhttp')
      || null;
  }

  function findXhttpInboundForPath(path) {
    // XHTTP (SplitHTTP) clients never request the literal configured
    // path: Xray normalizes it to end with `/` internally and (in our
    // config -- mode 'auto', no TLS/REALITY, no `extra` overrides --
    // which resolves to packet-up mode) appends a per-connection
    // session id, plus a sequence number per upload chunk, as extra
    // URL path segments after it: GET `{path}/{sessionId}` opens the
    // download stream, POST `{path}/{sessionId}/{seq}` sends each
    // upload chunk. An exact match against the stored `path` would
    // therefore 404 on every real request. Match the stored path
    // itself (harmless edge case) or anything starting with it plus a
    // `/` boundary; the request is still forwarded to xray-core
    // unmodified (full path incl. session/seq) -- xray-core's own
    // XHTTP handler parses those segments itself, so only this lookup
    // needed the prefix match. See docs/problem.md for the research
    // trail (XTLS/Xray-core's own config.go/dialer.go/hub.go).
    return listInbounds().find((row) => {
      if (row.transport !== 'xhttp') return false;
      const base = row.path.endsWith('/') ? row.path : `${row.path}/`;
      return path === row.path || path.startsWith(base);
    }) || null;
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

    const upstream = net.connect(internalPortForRow(inbound), '127.0.0.1', () => {
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
  function xhttpMiddleware(req, res, next) {
    const path = req.url.split('?')[0];
    const inbound = findXhttpInboundForPath(path);
    if (!inbound) return next();

    const upstreamReq = http.request(
      {
        host: '127.0.0.1',
        port: internalPortForRow(inbound),
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
  }

  return { xhttpMiddleware };
}

module.exports = { attachProxy };
