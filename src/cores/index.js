// Generic core abstraction: callers use getCore()/listCores(), never
// require a core module directly. Add new cores to CORES below.
'use strict';

const xrayCore = require('./xrayCore');

const CORES = {
  xray: xrayCore,
};

function getCore(name) {
  const core = CORES[name];
  if (!core) throw new Error(`Unknown core: ${name}`);
  return core;
}

function listCores() {
  return Object.values(CORES);
}

module.exports = { getCore, listCores };
