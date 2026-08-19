// In-memory health state for each generated inbound (see
// docs/product-vision.md rule 10: automatic health monitoring).
// Transient runtime data only, not persisted to the DB -- it
// naturally re-derives itself a few poll cycles after any restart,
// same reasoning as why xray/manager.js's process handle isn't
// persisted either.
'use strict';

// Consecutive failures before an endpoint is considered fully
// Unavailable rather than merely Degraded.
const UNAVAILABLE_AFTER_FAILURES = 3;

// inboundId -> { lastSuccess, lastFailure, failureCount, latencyMs,
//                totalChecks, totalSuccesses }
const state = new Map();

function getOrInit(inboundId) {
  let entry = state.get(inboundId);
  if (!entry) {
    entry = {
      lastSuccess: null,
      lastFailure: null,
      failureCount: 0,
      latencyMs: null,
      totalChecks: 0,
      totalSuccesses: 0,
    };
    state.set(inboundId, entry);
  }
  return entry;
}

/** Record a successful reachability check (TCP connect succeeded). */
function recordSuccess(inboundId, latencyMs) {
  const entry = getOrInit(inboundId);
  entry.lastSuccess = Date.now();
  entry.failureCount = 0;
  entry.latencyMs = latencyMs;
  entry.totalChecks += 1;
  entry.totalSuccesses += 1;
}

/** Record a failed reachability check (connect refused/timed out, or the owning core isn't running). */
function recordFailure(inboundId) {
  const entry = getOrInit(inboundId);
  entry.lastFailure = Date.now();
  entry.failureCount += 1;
  entry.totalChecks += 1;
}

/**
 * Derive a status label from one inbound's recorded state:
 *   - 'unknown'     no check has run yet
 *   - 'healthy'     most recent check succeeded
 *   - 'degraded'    currently failing, but under the Unavailable
 *                   threshold (or has failed at least once recently
 *                   even though the latest check succeeded)
 *   - 'unavailable' consecutive failures reached the threshold
 */
function statusFor(entry) {
  if (entry.totalChecks === 0) return 'unknown';
  if (entry.failureCount >= UNAVAILABLE_AFTER_FAILURES) return 'unavailable';
  if (entry.failureCount > 0) return 'degraded';
  return 'healthy';
}

/** Public snapshot for one inbound: status label + the raw counters. */
function getHealth(inboundId) {
  const entry = state.get(inboundId);
  if (!entry) {
    return {
      status: 'unknown',
      latencyMs: null,
      lastSuccess: null,
      lastFailure: null,
      failureCount: 0,
      availability: null,
    };
  }
  return {
    status: statusFor(entry),
    latencyMs: entry.latencyMs,
    lastSuccess: entry.lastSuccess,
    lastFailure: entry.lastFailure,
    failureCount: entry.failureCount,
    availability: entry.totalChecks > 0 ? entry.totalSuccesses / entry.totalChecks : null,
  };
}

/** Snapshot for every inbound that has ever been checked, keyed by id. */
function getAllHealth() {
  const result = {};
  for (const id of state.keys()) {
    result[id] = getHealth(id);
  }
  return result;
}

module.exports = { recordSuccess, recordFailure, getHealth, getAllHealth, UNAVAILABLE_AFTER_FAILURES };
