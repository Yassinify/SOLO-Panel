// Generic core abstraction (docs/product-vision.md rule 6): callers
// go through getCore()/listCores() and never require a specific core
// module (xrayCore.js, future singboxCore.js) directly. Adding a new
// core later means adding it to CORES here — no other file changes.
'use strict';

const xrayCore = require('./xrayCore');
const singboxCore = require('./singboxCore');

const CORES = {
  xray: xrayCore,
  singbox: singboxCore,
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
