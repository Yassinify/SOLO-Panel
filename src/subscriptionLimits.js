// Admin-settable subscription time limit (days) and usage limit (GB).
//
// Same "small fixed set of flags persisted in the existing app_config
// key/value table" pattern as src/modes.js. Defaults to 30 days / 80 GB
// (per user request) when the admin has never explicitly saved a value
// -- an admin can still set either field to unlimited by saving a
// deliberately-blank field (see setLimits() below), which is tracked
// as an explicit '' sentinel, distinct from "never touched".
//
// Scope note: this module only tracks and displays days-left/
// usage-left. It does not enforce the limit by blocking traffic once
// exceeded -- that would be a separate, larger change (see
// docs/how-program-work.md's Change Log entry for this feature).
'use strict';

const { getConfigValue, setConfigValue } = require('./db');

const BYTES_PER_GB = 1024 ** 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// app_config stores '' (empty string) as the "unlimited" sentinel for
// limit_days/limit_usage_gb, since there's no delete helper on that
// table -- getConfigValue distinguishes "never set" (null) from "set
// to unlimited" (''), but both mean unlimited here.
function isUnsetOrEmpty(value) {
  return value === null || value === '';
}

// Default limits applied when the admin has never explicitly saved a
// value for that field (getConfigValue returns null -- distinct from
// '', which means the admin deliberately chose "unlimited").
const DEFAULT_DAYS = 30;
const DEFAULT_USAGE_GB = 80;

/**
 * Current admin-set limits. `days`/`usageGB` fall back to
 * DEFAULT_DAYS/DEFAULT_USAGE_GB when never explicitly saved, or are
 * null when the admin explicitly saved a blank (unlimited) field.
 * `setAt` is the ISO timestamp the limits were last saved, used as
 * the countdown's start point; null if never saved.
 */
function getLimits() {
  const daysRaw = getConfigValue('limit_days');
  const usageRaw = getConfigValue('limit_usage_gb');
  const setAt = getConfigValue('limit_set_at');
  return {
    days: daysRaw === null ? DEFAULT_DAYS : (daysRaw === '' ? null : Number(daysRaw)),
    usageGB: usageRaw === null ? DEFAULT_USAGE_GB : (usageRaw === '' ? null : Number(usageRaw)),
    setAt,
  };
}

/**
 * Persist a new set of limits. `days`/`usageGB` of null/undefined/''/
 * <=0 mean "unlimited" for that dimension. Saving always resets the
 * countdown start point (`limit_set_at` = now) for both dimensions at
 * once -- setting new limits is treated as (re)starting a plan, same
 * mental model as renewing a subscription.
 */
function setLimits({ days, usageGB }) {
  const normalizedDays = isUnsetOrEmpty(days) || Number(days) <= 0 ? null : Math.floor(Number(days));
  const normalizedUsageGB = isUnsetOrEmpty(usageGB) || Number(usageGB) <= 0 ? null : Number(usageGB);

  setConfigValue('limit_days', normalizedDays === null ? '' : String(normalizedDays));
  setConfigValue('limit_usage_gb', normalizedUsageGB === null ? '' : String(normalizedUsageGB));
  setConfigValue('limit_set_at', new Date().toISOString());
}

/**
 * Days/usage summary given the current limits and a total-used byte
 * count (see inbounds.js's getTotalTrafficBytes()). `daysLeft`/
 * `usageLeftBytes` are null when that dimension is unlimited, and
 * never negative -- floor at 0 once a limit is exceeded (this module
 * doesn't act on that, just reports it -- see module header's scope
 * note). `usageUsedBytes`/`usageTotalGB` are included as-is so
 * callers can render a "<used> / <total>" style display.
 */
function getUsageSummary(totalUsedBytes) {
  const limits = getLimits();
  const unlimitedDays = limits.days === null;
  const unlimitedUsage = limits.usageGB === null;

  let daysLeft = null;
  if (!unlimitedDays) {
    const startedAt = limits.setAt ? new Date(limits.setAt).getTime() : Date.now();
    const elapsedDays = Math.floor((Date.now() - startedAt) / MS_PER_DAY);
    daysLeft = Math.max(0, limits.days - elapsedDays);
  }

  let usageLeftBytes = null;
  if (!unlimitedUsage) {
    usageLeftBytes = Math.max(0, limits.usageGB * BYTES_PER_GB - totalUsedBytes);
  }

  return {
    daysLeft,
    usageLeftBytes,
    usageUsedBytes: totalUsedBytes,
    usageTotalGB: limits.usageGB,
    unlimitedDays,
    unlimitedUsage,
  };
}

module.exports = { getLimits, setLimits, getUsageSummary };
