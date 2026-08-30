// Periodically polls every registered core's Stats API (see
// src/cores/index.js) and persists per-client traffic deltas into the
// DB via inbounds.addClientTraffic(). Kept separate from server.js to
// keep route wiring focused; started/stopped alongside the HTTP
// server's lifecycle. Core-agnostic on purpose — loops over every
// registered core (currently xray only) instead of hardcoding one,
// so a future additional core needs no change here.
'use strict';

const inbounds = require('../inbounds');
const { listCores } = require('../cores');

const POLL_INTERVAL_MS = 10000;

let timer = null;

async function pollOnce() {
  for (const core of listCores()) {
    // Skip silently if this core isn't running — getStats() would
    // just fail to connect anyway (it already swallows that error
    // itself, but skip the call entirely to avoid the log-worthy work).
    if (core.status() !== 'running') continue;

    const byClientId = await core.getStats();
    for (const [clientId, { uplink, downlink }] of byClientId) {
      if (uplink || downlink) {
        inbounds.addClientTraffic(clientId, uplink, downlink);
      }
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
