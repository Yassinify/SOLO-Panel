// Manages the sing-box binary as a child process: writes a generated
// config to disk, then starts/stops/restarts sing-box with it. Mirrors
// xray/manager.js's shape exactly (see that file's header) so both
// cores plug into src/cores/*Core.js identically.
'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'singbox-config.json');
const SINGBOX_BIN_PATH = process.env.SINGBOX_BIN_PATH || path.join(__dirname, '..', '..', 'bin', 'sing-box');

let singboxProcess = null;

function isRunning() {
  return singboxProcess !== null;
}

function writeConfig(config) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * Start sing-box with the given config object. No-op if already
 * running (call restart() to apply a new config to a running instance).
 */
function start(config) {
  if (isRunning()) {
    console.warn('sing-box already running; call restart() to apply a new config.');
    return;
  }

  // No inbounds to serve (e.g. before any singbox-core rows exist) -
  // nothing to start yet; avoids spawning sing-box with an empty
  // config, which it would otherwise happily run doing nothing.
  if (!config.inbounds || config.inbounds.length === 0) {
    return;
  }

  writeConfig(config);

  singboxProcess = spawn(SINGBOX_BIN_PATH, ['run', '-c', CONFIG_PATH], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  singboxProcess.stdout.on('data', (chunk) => {
    process.stdout.write(`[sing-box] ${chunk}`);
  });
  singboxProcess.stderr.on('data', (chunk) => {
    process.stderr.write(`[sing-box] ${chunk}`);
  });

  singboxProcess.on('exit', (code, signal) => {
    console.log(`[sing-box] process exited (code=${code}, signal=${signal})`);
    singboxProcess = null;
  });

  singboxProcess.on('error', (err) => {
    console.error('[sing-box] failed to start:', err.message);
    singboxProcess = null;
  });
}

/**
 * Stop sing-box if running. Returns a promise that resolves once the
 * process has actually exited.
 */
function stop() {
  return new Promise((resolve) => {
    if (!isRunning()) {
      resolve();
      return;
    }
    singboxProcess.once('exit', () => resolve());
    singboxProcess.kill('SIGTERM');
  });
}

/**
 * Stop the running instance (if any) and start again with a new
 * config. If the new config has zero inbounds, this just stops.
 */
async function restart(config) {
  await stop();
  start(config);
}

module.exports = { start, stop, restart, isRunning, CONFIG_PATH, SINGBOX_BIN_PATH };
