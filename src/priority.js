// Subscription ordering: rank inbounds Primary -> Secondary ->
// Fallback based on health, latency, and recovery state.
// Pure sorting logic -- reads in-memory snapshots from health.js/recovery.js.
'use strict';

const { getHealth } = require('./health');
const { isDeprioritized } = require('./recovery');

// Lower rank = higher priority.
const STATUS_RANK = {
  healthy: 0,
  degraded: 1,
  unknown: 2,
  unavailable: 3,
};

// Sort inbound rows into priority order (doesn't mutate input).
// Deprioritized-core rows sort last regardless of their own health.
// Otherwise: by health status rank, then by latency ascending.
function orderInbounds(rows) {
  return [...rows].sort((a, b) => {
    const aDeprioritized = isDeprioritized(a.core) ? 1 : 0;
    const bDeprioritized = isDeprioritized(b.core) ? 1 : 0;
    if (aDeprioritized !== bDeprioritized) return aDeprioritized - bDeprioritized;

    const aHealth = getHealth(a.id);
    const bHealth = getHealth(b.id);
    const aRank = STATUS_RANK[aHealth.status] ?? STATUS_RANK.unknown;
    const bRank = STATUS_RANK[bHealth.status] ?? STATUS_RANK.unknown;
    if (aRank !== bRank) return aRank - bRank;

    const aLatency = aHealth.latencyMs ?? Infinity;
    const bLatency = bHealth.latencyMs ?? Infinity;
    return aLatency - bLatency;
  });
}

module.exports = { orderInbounds };
