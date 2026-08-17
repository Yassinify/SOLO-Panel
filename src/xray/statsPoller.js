// Periodically polls Xray's Stats API and persists per-client traffic
// deltas into the DB via inbounds.addClientTraffic(). Kept separate
// from server.js to keep route wiring focused; started/stopped
// alongside the HTTP server's lifecycle.
'use strict';

const { queryStats, toClientTraffic } = require('./stats');
const inbounds = require('../inbounds');
const manager = require('./manager');

const POLL_INTERVAL_MS = 10000;

let timer = null;

async function pollOnce() {
  // Skip silently if xray-core isn't running (e.g. zero enabled
  // inbounds) — queryStats() would just fail to connect anyway.
  if (!manager.isRunning()) return;

  let raw;
  try {
    raw = await queryStats();
  } catch (err) {
    // Expected occasionally right after a restart while the api port
    // comes up; not worth logging every cycle.
    return;
  }

  const byClientId = toClientTraffic(raw);
  for (const [clientId, { uplink, downlink }] of byClientId) {
    if (uplink || downlink) {
      inbounds.addClientTraffic(clientId, uplink, downlink);
    }
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => {
    pollOnce().catch((err) => console.error('[stats-poller]', err.message));
  }, POLL_INTERVAL_MS);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop };
