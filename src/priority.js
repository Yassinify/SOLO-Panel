// Subscription ordering (see docs/product-vision.md rule 23):
//
//   Subscription endpoints should have an automatically determined
//   priority (Primary -> Secondary -> Fallback), based on health,
//   latency, availability, and runtime state -- never manually
//   configured by the admin.
//
// Pure sorting logic only, no DB/network access -- reads the existing
// in-memory snapshots from src/health.js and src/recovery.js.
'use strict';

const { getHealth } = require('./health');
const { isDeprioritized } = require('./recovery');

// Lower rank = higher priority. Matches vision rule 10's four states.
const STATUS_RANK = {
  healthy: 0,
  degraded: 1,
  unknown: 2,
  unavailable: 3,
};

/**
 * Sort inbound rows into priority order (does not mutate the input
 * array). Rows whose owning core is currently deprioritized by
 * automatic recovery (src/recovery.js, vision rule 11) always sort
 * after every non-deprioritized row, regardless of their own health --
 * a row that only happens to look healthy this cycle is still served
 * by a core recovery has already given up restarting for now.
 *
 * Within each of those two groups, sort by health status rank
 * (healthy first, then degraded, then unknown, then unavailable),
 * then by measured latency ascending (rows with no latency reading
 * yet sort after rows that have one, within the same status).
 */
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
