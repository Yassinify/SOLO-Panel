// Core-aware internal-port lookup for one `inbounds` row. Xray's
// module owns the internal port range (xray/config.js: 10000+id).
// Callers that need "the port this row's process is actually
// listening on" (server.js's dashboard, xray/proxy.js's connection
// routing) should go through this instead of using xray/config.js's
// formula directly, in case a second core is ever added back.
'use strict';

const { internalPortForInbound: xrayInternalPort } = require('../xray/config');

function internalPortForRow(row) {
  return xrayInternalPort(row.id);
}

module.exports = { internalPortForRow };
