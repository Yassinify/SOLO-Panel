// Per-mode enable/disable state (protocol / transport / alpn /
// fingerprint). Panel still auto-generates every combination with
// zero setup -- this only lets the admin turn specific modes off.
// State persisted in `app_config` as one flag per mode value.
'use strict';

const { getConfigValue, setConfigValue } = require('./db');
const { ALPN_VARIANTS, FINGERPRINTS } = require('./utils');

// Toggleable values per dimension. Kept in sync with inbounds.js's
// CORE_COMBOS. alpn/fingerprint aren't row attributes (see
// xray/links.js) -- consulted via getEnabledAlpnValues()/
// getEnabledFingerprints() instead of isRowEnabled().
const MODE_DIMENSIONS = {
  protocol: ['vless', 'trojan'],
  transport: ['ws', 'xhttp', 'httpupgrade', 'raw'],
  alpn: ALPN_VARIANTS,
  fingerprint: FINGERPRINTS,
};

// Default enabled value(s) per dimension before the admin ever saves
// a change. A value missing here defaults to disabled.
const MODE_DEFAULTS = {
  protocol: { vless: true },
  transport: { xhttp: true },
  alpn: { 'http/1.1': true },
  // 'randomized' is the only fingerprint that works across every
  // default ALPN variant -- 'chrome' fails on http/1.1.
  fingerprint: { randomized: true },
};

function configKey(dimension, value) {
  return `mode_${dimension}_${value}`;
}

// Human-friendly labels for the toggle UI (dashboard.ejs).
const MODE_LABELS = {
  protocol: { vless: 'VLESS', trojan: 'Trojan' },
  transport: { ws: 'WebSocket', xhttp: 'XHTTP', httpupgrade: 'HTTP Upgrade', raw: 'Raw (camouflaged TCP)' },
  alpn: { 'http/1.1': 'HTTP/1.1', h2: 'HTTP/2' },
  fingerprint: { chrome: 'Chrome', firefox: 'Firefox', safari: 'Safari', ios: 'iOS', android: 'Android', randomized: 'Randomized' },
};

// Display label for one mode value, or the raw value if unknown.
function labelForMode(dimension, value) {
  return (MODE_LABELS[dimension] && MODE_LABELS[dimension][value]) || value;
}

// Current enabled/disabled state for every mode, grouped by dimension.
function getModeState() {
  const state = {};
  for (const [dimension, values] of Object.entries(MODE_DIMENSIONS)) {
    state[dimension] = {};
    for (const value of values) {
      const stored = getConfigValue(configKey(dimension, value));
      const defaultEnabled = !!(MODE_DEFAULTS[dimension] && MODE_DEFAULTS[dimension][value]);
      state[dimension][value] = stored === null ? defaultEnabled : stored === '1';
    }
  }
  return state;
}

// Persist a full new mode state. Unrecognized keys are ignored.
function setModeState(newState) {
  for (const [dimension, values] of Object.entries(MODE_DIMENSIONS)) {
    for (const value of values) {
      const enabled = !!(newState[dimension] && newState[dimension][value]);
      setConfigValue(configKey(dimension, value), enabled ? '1' : '0');
    }
  }
}

// Whether a row should currently be served (protocol AND transport enabled).
function isRowEnabled(row, state = getModeState()) {
  return (
    !!state.protocol[row.protocol] &&
    !!state.transport[row.transport]
  );
}

// Dimension names with zero enabled values -- used to reject a save
// that would leave a whole dimension empty.
function emptyDimensions(state) {
  return Object.keys(MODE_DIMENSIONS).filter(
    (dimension) => !Object.values(state[dimension]).some(Boolean)
  );
}

// Enabled ALPN values, in original order. Used by xray/links.js.
function getEnabledAlpnValues(state = getModeState()) {
  return MODE_DIMENSIONS.alpn.filter((value) => !!state.alpn[value]);
}

// Enabled fingerprint values, in original order.
function getEnabledFingerprints(state = getModeState()) {
  return MODE_DIMENSIONS.fingerprint.filter((value) => !!state.fingerprint[value]);
}

module.exports = { MODE_DIMENSIONS, MODE_LABELS, labelForMode, getModeState, setModeState, isRowEnabled, emptyDimensions, getEnabledAlpnValues, getEnabledFingerprints };
