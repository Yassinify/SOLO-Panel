// Admin-settable "Advanced options" -- currently just simplified
// (numbered) link remarks. Its own small module, separate from
// modes.js/subscriptionLimits.js, since this dashboard section is
// meant to hold more unrelated advanced settings over time.
'use strict';

const { getConfigValue, setConfigValue } = require('./db');

// Whether generated link remarks should be simplified to
// "<protocol> - <number>" instead of the full descriptive
// "<protocol> - <transport> - <alpn> - <fingerprint>" (see
// xray/links.js's simpleRemarkFor()). Defaults to off.
function getSimpleRemarks() {
  return getConfigValue('simple_remarks') === '1';
}

function setSimpleRemarks(enabled) {
  setConfigValue('simple_remarks', enabled ? '1' : '0');
}

module.exports = { getSimpleRemarks, setSimpleRemarks };
