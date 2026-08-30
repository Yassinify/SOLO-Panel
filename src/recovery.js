// Automatic recovery for cores: Failure -> Detect -> Restart ->
// Validate -> Health Check -> Restore. Hooked into healthMonitor.js's
// per-cycle health check instead of running its own poll loop.
// In-memory only, re-derives after a restart.
'use strict';

const inbounds = require('./inbounds');

// Require 2 consecutive unhealthy checks before acting, so a single
// transient blip (a slow health-check call, a brief GC pause) doesn't
// trigger a restart.
const UNHEALTHY_CHECKS_BEFORE_ACTION = 2;
// Minimum time between restart attempts for the same core, so a core
// that's genuinely broken can't be restarted in a tight loop.
const RESTART_COOLDOWN_MS = 60 * 1000;
// Restart attempts allowed (since the last time the core was healthy)
// before giving up and deprioritizing instead of continuing to retry.
const MAX_RESTART_ATTEMPTS = 3;
// How long a core stays deprioritized before automatic recovery gives
// it one more chance (with a fresh attempt count).
const DEPRIORITIZE_COOLDOWN_MS = 30 * 60 * 1000;

// coreName -> { consecutiveUnhealthy, lastRestartAt, restartAttempts, deprioritizedUntil }
const state = new Map();

function getOrInit(coreName) {
  let entry = state.get(coreName);
  if (!entry) {
    entry = {
      consecutiveUnhealthy: 0,
      lastRestartAt: null,
      restartAttempts: 0,
      deprioritizedUntil: null,
    };
    state.set(coreName, entry);
  }
  return entry;
}

// Whether `coreName` is currently deprioritized after repeated failed
// restarts. Clears itself once the cooldown window passes.
function isDeprioritized(coreName) {
  const entry = state.get(coreName);
  if (!entry || !entry.deprioritizedUntil) return false;
  if (Date.now() >= entry.deprioritizedUntil) {
    entry.deprioritizedUntil = null;
    entry.restartAttempts = 0;
    return false;
  }
  return true;
}

// Read-only snapshot of one core's recovery state (logging/future UI).
function getRecoveryState(coreName) {
  const entry = state.get(coreName);
  if (!entry) {
    return { consecutiveUnhealthy: 0, lastRestartAt: null, restartAttempts: 0, deprioritized: false };
  }
  return {
    consecutiveUnhealthy: entry.consecutiveUnhealthy,
    lastRestartAt: entry.lastRestartAt,
    restartAttempts: entry.restartAttempts,
    deprioritized: isDeprioritized(coreName),
  };
}

// Called once per poll cycle with the core's healthCheck() result.
// Drives the recovery state machine described above.
async function reportCoreHealth(coreName, healthy) {
  const entry = getOrInit(coreName);

  if (healthy) {
    entry.consecutiveUnhealthy = 0;
    entry.restartAttempts = 0;
    return;
  }

  entry.consecutiveUnhealthy += 1;
  if (entry.consecutiveUnhealthy < UNHEALTHY_CHECKS_BEFORE_ACTION) return;
  if (isDeprioritized(coreName)) return; // already given up for now; don't hammer it

  const now = Date.now();
  if (entry.lastRestartAt && now - entry.lastRestartAt < RESTART_COOLDOWN_MS) return;

  if (entry.restartAttempts >= MAX_RESTART_ATTEMPTS) {
    entry.deprioritizedUntil = now + DEPRIORITIZE_COOLDOWN_MS;
    console.error(
      `[recovery] core '${coreName}' did not recover after ${entry.restartAttempts} restart attempts; ` +
      `deprioritizing for ${Math.round(DEPRIORITIZE_COOLDOWN_MS / 60000)} minutes`
    );
    return;
  }

  entry.lastRestartAt = now;
  entry.restartAttempts += 1;
  console.warn(
    `[recovery] core '${coreName}' unhealthy (x${entry.consecutiveUnhealthy}); ` +
    `attempting restart (attempt ${entry.restartAttempts}/${MAX_RESTART_ATTEMPTS})`
  );

  try {
    await inbounds.reloadCore(coreName);
  } catch (err) {
    console.error(`[recovery] restart of core '${coreName}' failed:`, err.message);
  }
}

module.exports = { reportCoreHealth, isDeprioritized, getRecoveryState };
