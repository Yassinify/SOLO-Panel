// Manages the xray-core binary as a child process: writes a generated
// config to disk, then starts/stops/restarts xray with it. xray-core
// only ever listens on internal loopback ports here.
'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'xray-config.json');
const XRAY_BIN_PATH = process.env.XRAY_BIN_PATH || path.join(__dirname, '..', '..', 'bin', 'xray');

let xrayProcess = null;

function isRunning() {
  return xrayProcess !== null;
}

function writeConfig(config) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// Start xray-core with the given config. No-op if already running
// (call restart() to apply a new config to a running instance).
function start(config) {
  if (isRunning()) {
    console.warn('xray-core already running; call restart() to apply a new config.');
    return;
  }

  writeConfig(config);

  xrayProcess = spawn(XRAY_BIN_PATH, ['run', '-config', CONFIG_PATH], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  xrayProcess.stdout.on('data', (chunk) => {
    process.stdout.write(`[xray] ${chunk}`);
  });
  xrayProcess.stderr.on('data', (chunk) => {
    process.stderr.write(`[xray] ${chunk}`);
  });

  xrayProcess.on('exit', (code, signal) => {
    console.log(`[xray] process exited (code=${code}, signal=${signal})`);
    xrayProcess = null;
  });

  xrayProcess.on('error', (err) => {
    console.error('[xray] failed to start:', err.message);
    xrayProcess = null;
  });
}

// Stop xray-core if running. Resolves once the process has exited.
function stop() {
  return new Promise((resolve) => {
    if (!isRunning()) {
      resolve();
      return;
    }
    xrayProcess.once('exit', () => resolve());
    xrayProcess.kill('SIGTERM');
  });
}

// Stop the running instance (if any) and start again with a new config.
async function restart(config) {
  await stop();
  start(config);
}

module.exports = { start, stop, restart, isRunning, CONFIG_PATH, XRAY_BIN_PATH };
