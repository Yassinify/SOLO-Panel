// Core-aware internal-port lookup for one `inbounds` row. Each core
// module owns its own internal port range (xray/config.js: 10000+id,
// singbox/config.js: 20000+id -- see that file's header for why the
// ranges are kept separate) so ids can safely overlap between cores.
// Callers that need "the port this row's process is actually
// listening on" (server.js's dashboard, xray/proxy.js's connection
// routing) should go through this instead of picking one core's
// formula directly.
'use strict';

const { internalPortForInbound: xrayInternalPort } = require('../xray/config');
const { internalPortForInbound: singboxInternalPort } = require('../singbox/config');

function internalPortForRow(row) {
  return row.core === 'singbox' ? singboxInternalPort(row.id) : xrayInternalPort(row.id);
}

module.exports = { internalPortForRow };
