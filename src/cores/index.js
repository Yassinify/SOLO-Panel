// Generic core abstraction (docs/product-vision.md rule 6): callers
// go through getCore()/listCores() and never require a specific core
// module (xrayCore.js) directly. Adding a new core later means adding
// it to CORES here -- no other file changes. sing-box support was
// removed 2026-08-29 per user request (xray-only now) -- see
// docs/how-program-work.md's Change Log.
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
