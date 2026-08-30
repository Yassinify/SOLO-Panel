// Queries Xray-core's Stats API using the `xray api statsquery` CLI
// subcommand (bundled with the xray-core binary we already download in
// scripts/install-xray.js). No gRPC client library is needed in Node —
// the binary itself speaks gRPC to its own Stats API on STATS_API_PORT
// and prints the result as JSON on stdout.
'use strict';

const { execFile } = require('child_process');
const { XRAY_BIN_PATH } = require('./manager');
const { STATS_API_PORT } = require('./config');

/**
 * Run `xray api statsquery` and parse the result into a plain map of
 * stat name -> numeric value (uplink/downlink counters reset to 0 by
 * Xray after each query, since we pass -reset).
 *
 * Stat names look like:
 *   "user>>>client-7>>>traffic>>>uplink"
 *   "inbound>>>inbound-3>>>traffic>>>downlink"
 *
 * @returns {Promise<Object<string, number>>}
 */
function queryStats() {
  return new Promise((resolve, reject) => {
    execFile(
      XRAY_BIN_PATH,
      ['api', 'statsquery', `-server=127.0.0.1:${STATS_API_PORT}`, '-reset'],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) {
          // Common when xray-core isn't running yet (no inbounds
          // configured) or the api port isn't up — not a hard failure.
          reject(err);
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          const result = {};
          for (const entry of parsed.stat || []) {
            result[entry.name] = Number(entry.value) || 0;
          }
          resolve(result);
        } catch (parseErr) {
          reject(parseErr);
        }
      }
    );
  });
}

/**
 * Parse a raw stats map (from queryStats) into per-inbound uplink/downlink
 * totals, keyed by the numeric `inbounds.id` (Xray's "email" tag is
 * set to `client-<id>` by config.js's statsTagForClient()).
 * @param {Object<string, number>} rawStats
 * @returns {Map<number, {uplink: number, downlink: number}>}
 */
function toClientTraffic(rawStats) {
  const byClientId = new Map();

  for (const [name, value] of Object.entries(rawStats)) {
    const match = /^user>>>client-(\d+)>>>traffic>>>(uplink|downlink)$/.exec(name);
    if (!match) continue;

    const clientId = Number(match[1]);
    const direction = match[2];
    if (!byClientId.has(clientId)) {
      byClientId.set(clientId, { uplink: 0, downlink: 0 });
    }
    byClientId.get(clientId)[direction] += value;
  }

  return byClientId;
}

module.exports = { queryStats, toClientTraffic };
