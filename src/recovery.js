// Automatic recovery for cores (see docs/product-vision.md rule 11):
//
//   Failure -> Detect -> Restart/Repair -> Validate -> Health Check -> Restore
//
// Hooked into src/healthMonitor.js's existing per-cycle core health
// check (see that file) rather than running its own poll loop --
// every health check IS the "Validate / Health Check" step for
// whatever the previous cycle did, so no separate loop is needed.
//
// In-memory only, same reasoning as src/health.js: this is transient
// runtime/operational state, not configuration, and naturally
// re-derives after a restart.
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

/**
 * Whether `coreName` is currently deprioritized (vision rule 11: after
 * repeated failed recovery attempts, stop retrying and change
 * priority instead). Clears itself (and resets the attempt count) once
 * the cooldown window has passed, so recovery gets one more try later
 * rather than giving up permanently.
 */
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

/** Read-only snapshot of one core's recovery state, for logging/future UI. */
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

/**
 * Called once per poll cycle (from healthMonitor.js) with the result
 * of `coreName`'s own healthCheck(). Drives the recovery state
 * machine described in this file's header.
 */
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
