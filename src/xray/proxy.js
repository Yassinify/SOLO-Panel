// Lets Xray's WS/XHTTP/HTTPUpgrade/raw inbounds share Railway's single
// public port with the Express panel UI. Railway forwards everything
// on 0.0.0.0:$PORT to this module (see server.js, which listens via a
// plain net.Server and hands every accepted socket to
// `handleConnection` below instead of letting the Express app's
// http.Server listen directly), so this module can route each
// connection to the right place before HTTP parsing even happens:
//   - `raw` fakes an HTTP request line/headers as camouflage, then
//     immediately continues the same TCP stream as raw (non-HTTP)
//     protocol bytes. Node's own http.Server can't cope with that (no
//     Content-Length, and what follows isn't a valid next HTTP
//     message), so `raw` connections are sniffed and forwarded at the
//     raw TCP level, before the http.Server ever sees them.
//   - Everything else (the panel UI, plus ws/xhttp/httpupgrade
//     inbounds) is handed to the http.Server exactly as if it had
//     accepted the connection itself, and is routed the same way as
//     before: WS/HTTPUpgrade via the 'upgrade' event, XHTTP via
//     `xhttpMiddleware` — both matched by path against the generated
//     inbounds' `path` column.
'use strict';

const http = require('http');
const net = require('net');

// How long to wait for a full camouflage header (ending `\r\n\r\n`)
// before giving up and treating the connection as ordinary HTTP.
const RAW_SNIFF_TIMEOUT_MS = 3000;
// Camouflage headers are small (a handful of short lines); bail out
// well before this so a connection that will never send `\r\n\r\n`
// can't make us buffer unboundedly.
const RAW_SNIFF_MAX_BYTES = 8192;

/**
 * @param {import('http').Server} server - the Express app's HTTP server.
 *   Never listens directly (see server.js) — non-`raw` connections are
 *   handed to it via `server.emit('connection', socket)` from
 *   `handleConnection` below, which makes it behave exactly as if it
 *   had accepted the connection itself.
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
    return listInbounds().find((row) => row.path === path && row.transport !== 'xhttp' && row.transport !== 'raw')
      || null;
  }

  // `raw` inbound paths are stored with a query string (e.g.
  // `?ed=2560`, the early-data hint — see utils.js's
  // generateRawHttpPath), but xray-core's own `raw` header match (see
  // xray/config.js) and real clients' request lines only carry the
  // path segment, so this compares path-only on both sides.
  function findRawInboundForPath(path) {
    return listInbounds().find((row) => row.transport === 'raw' && row.path.split('?')[0] === path)
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

  /**
   * Entry point for every accepted TCP connection (see server.js,
   * which listens via a plain net.Server and calls this instead of
   * letting the http.Server listen itself). Peeks at the connection's
   * first bytes looking for a `raw` inbound's camouflage request line
   * (`METHOD /path HTTP/1.1`, matched on path only, same as the other
   * transports). On a match, the socket is piped straight to that
   * inbound's internal port, replaying whatever was already buffered
   * — the http.Server never sees these bytes. Anything else (no
   * match, timeout, or malformed data) is handed to the http.Server
   * unchanged, exactly as if that server had accepted the connection
   * itself.
   */
  function handleConnection(socket) {
    let buffered = Buffer.alloc(0);
    let settled = false;

    const timer = setTimeout(() => finish(null), RAW_SNIFF_TIMEOUT_MS);

    function finish(inbound) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onSocketError);
      socket.removeListener('close', onSocketClose);

      if (!inbound) {
        if (buffered.length) socket.unshift(buffered);
        server.emit('connection', socket);
        return;
      }

      const upstream = net.connect(internalPortForRow(inbound), '127.0.0.1', () => {
        upstream.write(buffered);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    }

    function onSocketError() { finish(null); }
    function onSocketClose() { finish(null); }

    function onData(chunk) {
      buffered = Buffer.concat([buffered, chunk]);

      const headerEnd = buffered.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        if (buffered.length > RAW_SNIFF_MAX_BYTES) finish(null);
        return;
      }

      const firstLineEnd = buffered.indexOf('\r\n');
      const requestLine = buffered.slice(0, firstLineEnd).toString('utf8');
      const match = /^\S+\s+(\S+)\s+HTTP\/\d\.\d$/.exec(requestLine);
      const path = match ? match[1].split('?')[0] : null;

      finish(path ? findRawInboundForPath(path) : null);
    }

    socket.on('data', onData);
    socket.on('error', onSocketError);
    socket.on('close', onSocketClose);
  }

  return { xhttpMiddleware, handleConnection };
}

module.exports = { attachProxy };
