// Xray-core implementation of the generic CoreManager interface (see
// docs/product-vision.md rule 6). Wraps the existing xray/* modules —
// none of their internal behavior changes here, this file only
// exposes them through the shape every core (xray, future sing-box)
// must implement, so callers never depend on "xray" specifically.
'use strict';

const fs = require('fs');
const manager = require('../xray/manager');
const { buildXrayConfig } = require('../xray/config');
const { queryStats, toClientTraffic } = require('../xray/stats');

const NAME = 'xray';

/** Build an Xray-core config object from `inbounds` DB rows. */
function generateConfig(inboundRows) {
  return buildXrayConfig(inboundRows);
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

/** Whether the xray-core binary is present (installed by scripts/install-xray.js). */
async function install() {
  return fs.existsSync(manager.XRAY_BIN_PATH);
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

/** Per-client traffic since the last call, keyed by inbound_clients.id. */
async function getStats() {
  try {
    return toClientTraffic(await queryStats());
  } catch (err) {
    return new Map();
  }
}

/**
 * Minimal health check: process alive + Stats API reachable. Reserved
 * for the automatic-recovery step (vision rule 11); not wired into
 * anything yet.
 */
async function healthCheck() {
  if (!manager.isRunning()) {
    return { healthy: false, reason: 'process not running' };
  }
  try {
    await queryStats();
    return { healthy: true };
  } catch (err) {
    return { healthy: false, reason: err.message };
  }
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
