// Lets a VPN client's own subscription-link refresh trigger an xray
// restart, capped at MAX_RESTARTS_PER_WINDOW per rolling window. This
// exists because a stuck protocol (see docs/problem.md) only ever
// gets fixed today by a manual settings save that happens to restart
// xray -- this gives the same fix to the user whose client refreshes
// its subscription, without a scheduled/automatic restart and
// without letting frequent client polling restart cores too often.
//
// Deliberately separate from -- and uncapped relative to -- the
// mode-toggle-triggered restart in server.js's POST
// /settings/advanced, which always restarts when the mode selection
// actually changes, regardless of this limiter's state.
'use strict';

const inbounds = require('./inbounds');

const MAX_RESTARTS_PER_WINDOW = 3;
const WINDOW_MS = 60 * 60 * 1000; // 1 hour

// In-memory only, like recovery.js's cooldown state -- resets on
// process restart, which is fine since a restart already happened.
let restartTimestamps = [];

// Call on every subscription-link fetch (see server.js's
// sendRawSubscription). Fires a background core reload if under the
// rate cap; never blocks or throws into the caller -- a failed
// reload here shouldn't affect the subscription response.
function maybeRestartOnSubscriptionFetch() {
  const now = Date.now();
  restartTimestamps = restartTimestamps.filter((t) => now - t < WINDOW_MS);
  if (restartTimestamps.length >= MAX_RESTARTS_PER_WINDOW) return;

  restartTimestamps.push(now);
  inbounds.reloadCores().catch((err) => {
    console.error('[sub-restart] reloadCores failed:', err.message);
  });
}

module.exports = { maybeRestartOnSubscriptionFetch };
