// Xray-core implementation of the generic core interface (see cores/index.js).
'use strict';

const fs = require('fs');
const net = require('net');
const manager = require('../xray/manager');
const { buildXrayConfig, STATS_API_PORT } = require('../xray/config');
const { queryStats, toClientTraffic } = require('../xray/stats');

const NAME = 'xray';

// Build an Xray-core config object from `inbounds` DB rows.
function generateConfig(inboundRows) {
  return buildXrayConfig(inboundRows);
}

// Try building a config; report success/failure instead of throwing.
function validateConfig(inboundRows) {
  try {
    generateConfig(inboundRows);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

// Whether the xray-core binary is installed.
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

// Per-client traffic since the last call, keyed by inbound_clients.id.
async function getStats() {
  try {
    return toClientTraffic(await queryStats());
  } catch {
    return new Map();
  }
}

const STATS_PORT_TIMEOUT_MS = 2000;

// Resolves if xray's Stats API port accepts a TCP connection. Used by
// healthCheck() instead of queryStats(): that spawns an `xray` CLI
// process (and with -reset also wipes the traffic counters), far too
// costly to run on every health-monitor cycle.
function checkStatsPort() {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: STATS_API_PORT, timeout: STATS_PORT_TIMEOUT_MS });
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('stats API port timed out')); });
    socket.once('error', (err) => { socket.destroy(); reject(err); });
  });
}

// Health check: process alive + Stats API port accepting connections.
async function healthCheck() {
  if (!manager.isRunning()) {
    return { healthy: false, reason: 'process not running' };
  }
  try {
    await checkStatsPort();
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
