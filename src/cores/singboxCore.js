// sing-box implementation of the generic CoreManager interface (see
// docs/product-vision.md rule 6). Second core alongside xrayCore.js -
// nothing outside src/cores/ ever requires this file directly, see
// src/cores/index.js.
'use strict';

const fs = require('fs');
const manager = require('../singbox/manager');
const { buildSingboxConfig } = require('../singbox/config');

const NAME = 'singbox';

/** Build a sing-box config object from `inbounds` DB rows (core === 'singbox' rows only). */
function generateConfig(inboundRows) {
  return buildSingboxConfig(inboundRows);
}

/** Try building a config; report success/failure instead of throwing. */
function validateConfig(inboundRows) {
  try {
    generateConfig(inboundRows);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

/** Whether the sing-box binary is present (installed by scripts/install-singbox.js). */
async function install() {
  return fs.existsSync(manager.SINGBOX_BIN_PATH);
}

function start(inboundRows) {
  manager.start(generateConfig(inboundRows));
}

function stop() {
  return manager.stop();
}

async function restart(inboundRows) {
  await manager.restart(generateConfig(inboundRows));
}

function status() {
  return manager.isRunning() ? 'running' : 'stopped';
}

/**
 * Per-client traffic. NOT IMPLEMENTED for sing-box: sing-box's stats
 * API (V2Ray API) requires a `with_v2ray_api` build tag that the
 * official prebuilt release binaries downloaded by
 * scripts/install-singbox.js are not guaranteed to include, unlike
 * xray-core where `xray api statsquery` always works (see
 * xray/stats.js). Documented rather than faked, same policy as the
 * original (pre-abstraction) Xray traffic-stats feature before it was
 * implemented - see the 2026-08-17 "Traffic-stats display" entry
 * below. Returns an empty map so callers (statsPoller.js) get a
 * harmless no-op instead of an error.
 */
async function getStats() {
  return new Map();
}

/**
 * Minimal health check: process alive only (no stats API to verify
 * reachability against, see getStats() above). Reserved for the
 * automatic-recovery step (vision rule 11); not wired into anything
 * yet.
 */
async function healthCheck() {
  return manager.isRunning()
    ? { healthy: true }
    : { healthy: false, reason: 'process not running' };
}

module.exports = {
  name: NAME,
  install,
  start,
  stop,
  restart,
  status,
  validateConfig,
  generateConfig,
  getStats,
  healthCheck,
};
