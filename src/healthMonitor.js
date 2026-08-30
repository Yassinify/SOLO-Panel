// Periodically checks every generated inbound's reachability and
// records the result into health.js. Also feeds each core's health
// check into recovery.js. Same shape as xray/statsPoller.js.
'use strict';

const net = require('net');
const inbounds = require('./inbounds');
const { getCore } = require('./cores');
const { internalPortForRow } = require('./cores/ports');
const { recordSuccess, recordFailure } = require('./health');
const { reportCoreHealth } = require('./recovery');
const { getModeState, isRowEnabled } = require('./modes');

const POLL_INTERVAL_MS = 15000;
const CONNECT_TIMEOUT_MS = 3000;

let timer = null;

// TCP-connect to one inbound's internal port and measure latency.
// Only proves the listener accepts connections, not a full handshake.
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
  // Cache each core's healthCheck() result per poll cycle (one call
  // per core, not per row).
  const coreHealthCache = new Map();

  async function isCoreHealthy(coreName) {
    if (coreHealthCache.has(coreName)) return coreHealthCache.get(coreName);
    const result = await getCore(coreName).healthCheck();
    // Feeds automatic recovery -- see recovery.js.
    await reportCoreHealth(coreName, result.healthy);
    coreHealthCache.set(coreName, result.healthy);
    return result.healthy;
  }

  // Skip rows whose mode is disabled (modes.js) -- their port was
  // never opened, so left at 'unknown' instead of probed.
  const modeState = getModeState();
  for (const row of inbounds.listInbounds()) {
    if (!isRowEnabled(row, modeState)) continue;

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
