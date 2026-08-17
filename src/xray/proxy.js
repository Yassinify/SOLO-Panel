// Shares Railway's single public port between the Express panel UI
// and xray-core's WebSocket inbounds.
//
// Xray-core only ever listens on internal loopback ports (see
// docs/how-program-work.md and xray/config.js). This module hooks the
// underlying HTTP server's `upgrade` event: any WebSocket handshake
// whose request path matches an enabled inbound's `listen_path` gets
// its raw TCP connection forwarded to that inbound's internal port;
// everything else (normal HTTP requests) continues to Express as usual
// and never touches this code at all.
'use strict';

const net = require('net');
const inbounds = require('../inbounds');
const { internalPortForInbound } = require('./config');

function attachWsProxy(server) {
  server.on('upgrade', (req, clientSocket, head) => {
    const requestPath = req.url.split('?')[0];
    const match = inbounds
      .listInbounds()
      .find((row) => row.enabled && row.listen_path === requestPath);

    if (!match) {
      clientSocket.destroy();
      return;
    }

    const targetPort = internalPortForInbound(match.id);
    const targetSocket = net.connect(targetPort, '127.0.0.1', () => {
      let rawRequest = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        rawRequest += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      }
      rawRequest += '\r\n';

      targetSocket.write(rawRequest);
      if (head && head.length) targetSocket.write(head);

      targetSocket.pipe(clientSocket);
      clientSocket.pipe(targetSocket);
    });

    targetSocket.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => targetSocket.destroy());
  });
}

module.exports = { attachWsProxy };
