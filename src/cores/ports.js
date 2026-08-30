// Core-aware internal-port lookup for one `inbounds` row. Use this
// instead of xray/config.js's formula directly.
'use strict';

const { internalPortForInbound: xrayInternalPort } = require('../xray/config');

function internalPortForRow(row) {
  return xrayInternalPort(row.id);
}

module.exports = { internalPortForRow };
