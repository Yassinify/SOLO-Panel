// In-memory health state for each generated inbound. Not persisted
// to the DB — re-derives itself after a restart.
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

// Record a successful reachability check.
function recordSuccess(inboundId, latencyMs) {
  const entry = getOrInit(inboundId);
  entry.lastSuccess = Date.now();
  entry.failureCount = 0;
  entry.latencyMs = latencyMs;
  entry.totalChecks += 1;
  entry.totalSuccesses += 1;
}

// Record a failed reachability check.
function recordFailure(inboundId) {
  const entry = getOrInit(inboundId);
  entry.lastFailure = Date.now();
  entry.failureCount += 1;
  entry.totalChecks += 1;
}

// Derive a status label: unknown / healthy / degraded / unavailable.
function statusFor(entry) {
  if (entry.totalChecks === 0) return 'unknown';
  if (entry.failureCount >= UNAVAILABLE_AFTER_FAILURES) return 'unavailable';
  if (entry.failureCount > 0) return 'degraded';
  return 'healthy';
}

// Public snapshot for one inbound: status label + raw counters.
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

// Snapshot for every checked inbound, keyed by id.
function getAllHealth() {
  const result = {};
  for (const id of state.keys()) {
    result[id] = getHealth(id);
  }
  return result;
}

module.exports = { recordSuccess, recordFailure, getHealth, getAllHealth, UNAVAILABLE_AFTER_FAILURES };
