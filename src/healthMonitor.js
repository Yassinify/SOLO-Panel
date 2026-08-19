// Periodically checks every generated inbound's reachability and
// records the result into src/health.js (see docs/product-vision.md
// rule 10: automatic health monitoring). Same shape as
// xray/statsPoller.js -- started/stopped alongside the HTTP server.
// Also feeds each core's health-check result into src/recovery.js
// (vision rule 11: automatic recovery) -- see isCoreHealthy() below.
'use strict';

const net = require('net');
const inbounds = require('./inbounds');
const { getCore } = require('./cores');
const { internalPortForRow } = require('./cores/ports');
const { recordSuccess, recordFailure } = require('./health');
const { reportCoreHealth } = require('./recovery');

const POLL_INTERVAL_MS = 15000;
const CONNECT_TIMEOUT_MS = 3000;

let timer = null;

/**
 * TCP-connect to one inbound's internal port and measure how long it
 * takes to establish the connection. This only proves the owning
 * core's listener is accepting connections on that port -- it is not
 * a full protocol handshake -- but that's the same signal a client's
 * very first connection attempt depends on, and is cheap enough to
 * run on every generated endpoint every poll cycle.
 */
function checkPort(port) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = net.connect({ host: '127.0.0.1', port, timeout: CONNECT_TIMEOUT_MS });

    function finish(ok) {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok ? Date.now() - start : null);
    }

    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function pollOnce() {
  // Cache each core's own healthCheck() result for this poll cycle
  // (one call per core, not one per row) -- rows whose owning core
  // isn't healthy are marked failed without bothering to TCP-connect,
  // since the port won't be listening anyway.
  const coreHealthCache = new Map();

  async function isCoreHealthy(coreName) {
    if (coreHealthCache.has(coreName)) return coreHealthCache.get(coreName);
    const result = await getCore(coreName).healthCheck();
    // Every health check doubles as the "Validate / Health Check" step
    // of the previous cycle's recovery attempt (see src/recovery.js's
    // header) -- feeding the result in here means automatic recovery
    // needs no poll loop of its own.
    await reportCoreHealth(coreName, result.healthy);
    coreHealthCache.set(coreName, result.healthy);
    return result.healthy;
  }

  for (const row of inbounds.listInbounds()) {
    const coreHealthy = await isCoreHealthy(row.core);
    if (!coreHealthy) {
      recordFailure(row.id);
      continue;
    }

    const latencyMs = await checkPort(internalPortForRow(row));
    if (latencyMs === null) {
      recordFailure(row.id);
    } else {
      recordSuccess(row.id, latencyMs);
    }
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => {
    pollOnce().catch((err) => console.error('[health-monitor]', err.message));
  }, POLL_INTERVAL_MS);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, pollOnce };
