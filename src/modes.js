// Per-mode enable/disable state (protocol / transport).
//
// This is a deliberate, user-requested exception to
// docs/product-vision.md rules 7 and 20 (see that doc's "Advanced:
// per-mode enable/disable" note and docs/how-program-work.md's Change
// Log for context). The panel still auto-generates every combination
// with zero required setup — this only lets the admin optionally turn
// specific already-generated modes off or on. See the "Default-
// enabled subset" note below for what's active before the admin ever
// opens this section.
//
// State is persisted in the existing `app_config` key/value table
// (one row per mode, e.g. `mode_protocol_vless` -> '1' or '0') rather than
// a new table, since it's a small fixed set of flags.
//
// Default-enabled subset (added 2026-08-29, explicit user request --
// see the matching note under product-vision.md rule 9): a never-
// toggled value no longer defaults to enabled across the board.
// Instead only one representative combination starts on (VLESS,
// WebSocket, HTTP/1.1 ALPN, Chrome fingerprint) -- see
// MODE_DEFAULTS below. Every other combination is still generated and
// is one click away in the Advanced section; only what's active with
// zero admin interaction changed.
'use strict';

const { getConfigValue, setConfigValue } = require('./db');
const { ALPN_VARIANTS, FINGERPRINTS } = require('./utils');

// The full set of toggleable values per dimension. Kept in sync by
// hand with src/inbounds.js's CORE_COMBOS — these are the only
// protocol/transport values the panel ever generates rows for.
// `alpn`/`fingerprint` are not row attributes (see xray/links.js) —
// they're link-generation-time fan-out values, so they're toggled the
// same way but consulted via getEnabledAlpnValues()/
// getEnabledFingerprints() instead of isRowEnabled().
const MODE_DIMENSIONS = {
  protocol: ['vless', 'trojan'],
  transport: ['ws', 'xhttp', 'httpupgrade', 'raw', 'reality'],
  alpn: ALPN_VARIANTS,
  fingerprint: FINGERPRINTS,
};

// Which value(s) per dimension are enabled the first time this app
// runs (i.e. before the admin has ever saved a mode change) -- see
// the module header note above. A value missing from a dimension here
// defaults to disabled. 'reality' (added 2026-08-29) is deliberately
// left disabled by default -- unlike every other transport it needs a
// one-time manual step (attaching a Railway TCP Proxy and saving the
// assigned address) before it can actually be reached, so it
// shouldn't turn on for a deployment the admin hasn't configured yet.
const MODE_DEFAULTS = {
  protocol: { vless: true },
  transport: { ws: true },
  alpn: { 'http/1.1': true },
  // 'randomized' is the only fingerprint confirmed (2026-08-29 xhttp
  // retest, see docs/problem.md) to work across every default ALPN
  // variant (http/1.1, h2, h2,http/1.1) -- 'chrome' fails on
  // http/1.1, the previous default ALPN, so it would have shipped a
  // known-broken default pairing.
  fingerprint: { randomized: true },
};

function configKey(dimension, value) {
  return `mode_${dimension}_${value}`;
}

// Human-friendly labels for the toggle UI (dashboard.ejs), same
// friendly-naming philosophy as utils.js's TECH_EXPLANATIONS (vision
// rules 16/31) -- an admin shouldn't need to already know what
// "httpupgrade" means to toggle it.
const MODE_LABELS = {
  protocol: { vless: 'VLESS', trojan: 'Trojan' },
  transport: { ws: 'WebSocket', xhttp: 'XHTTP', httpupgrade: 'HTTP Upgrade', raw: 'Raw (camouflaged TCP)', reality: 'REALITY (needs setup)' },
  alpn: { 'http/1.1': 'HTTP/1.1', h2: 'HTTP/2', 'h2,http/1.1': 'HTTP/2 + HTTP/1.1' },
  fingerprint: { chrome: 'Chrome', firefox: 'Firefox', safari: 'Safari', ios: 'iOS', android: 'Android', randomized: 'Randomized' },
};

/** Display label for one mode value, or the raw value if unknown. */
function labelForMode(dimension, value) {
  return (MODE_LABELS[dimension] && MODE_LABELS[dimension][value]) || value;
}

/**
 * Current enabled/disabled state for every mode, grouped by
 * dimension. Missing keys (never toggled before) default per
 * MODE_DEFAULTS above — see module header.
 */
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

/**
 * Persist a full new mode state (same shape as getModeState()'s
 * return value). Only known dimension/value pairs are written —
 * unrecognized keys in `newState` are silently ignored, so a stray
 * form field can't create bogus config rows.
 */
function setModeState(newState) {
  for (const [dimension, values] of Object.entries(MODE_DIMENSIONS)) {
    for (const value of values) {
      const enabled = !!(newState[dimension] && newState[dimension][value]);
      setConfigValue(configKey(dimension, value), enabled ? '1' : '0');
    }
  }
}

/**
 * Whether a given `inbounds` row should currently be served, i.e. its
 * protocol AND transport are both enabled. Used to filter rows
 * before generating core config and before building subscription
 * content, so a disabled mode disappears from both at once.
 */
function isRowEnabled(row, state = getModeState()) {
  return (
    !!state.protocol[row.protocol] &&
    !!state.transport[row.transport]
  );
}

/**
 * Dimension names in `state` that have zero enabled values. Used to
 * reject a /settings/modes submission that would leave a whole
 * dimension with nothing enabled -- e.g. disabling every Protocol
 * value would leave the panel with nothing to generate/serve at all for
 * that dimension. Every dimension must always keep at least one
 * option on.
 */
function emptyDimensions(state) {
  return Object.keys(MODE_DIMENSIONS).filter(
    (dimension) => !Object.values(state[dimension]).some(Boolean)
  );
}

/**
 * ALPN values currently enabled, in MODE_DIMENSIONS.alpn's original
 * order. Used by xray/links.js's link-building fan-out instead of
 * isRowEnabled() since ALPN isn't a per-row attribute (see that
 * file's header comment).
 */
function getEnabledAlpnValues(state = getModeState()) {
  return MODE_DIMENSIONS.alpn.filter((value) => !!state.alpn[value]);
}

/**
 * TLS fingerprint values currently enabled, in
 * MODE_DIMENSIONS.fingerprint's original order. Same rationale as
 * getEnabledAlpnValues() — fingerprint is a link-generation-time
 * fan-out value, not a per-row attribute.
 */
function getEnabledFingerprints(state = getModeState()) {
  return MODE_DIMENSIONS.fingerprint.filter((value) => !!state.fingerprint[value]);
}

module.exports = { MODE_DIMENSIONS, MODE_LABELS, labelForMode, getModeState, setModeState, isRowEnabled, emptyDimensions, getEnabledAlpnValues, getEnabledFingerprints };
