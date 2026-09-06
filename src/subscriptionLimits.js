// Admin-settable subscription time limit (days) and usage limit (GB).
// Persisted in app_config, defaults to unlimited when never saved.
// Only tracks/displays days-left/usage-left -- doesn't enforce it.
'use strict';

const { getConfigValue, setConfigValue } = require('./db');
const { usageLimitGbToBytes, MS_PER_DAY } = require('./utils');

// '' means "explicitly set to unlimited"; null means "never set" (both unlimited here).
function isUnsetOrEmpty(value) {
  return value === null || value === '';
}

// Default limits when never explicitly saved. Both unlimited.
const DEFAULT_DAYS = null;
const DEFAULT_USAGE_GB = null;

// Current admin-set limits. `setAt` is when limits were last saved
// (the countdown's start point), null if never saved.
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

// Persist new limits. null/undefined/''/<=0 means "unlimited".
// Saving always resets the countdown start point (limit_set_at = now).
function setLimits({ days, usageGB }) {
  const normalizedDays = isUnsetOrEmpty(days) || Number(days) <= 0 ? null : Math.floor(Number(days));
  const normalizedUsageGB = isUnsetOrEmpty(usageGB) || Number(usageGB) <= 0 ? null : Number(usageGB);

  setConfigValue('limit_days', normalizedDays === null ? '' : String(normalizedDays));
  setConfigValue('limit_usage_gb', normalizedUsageGB === null ? '' : String(normalizedUsageGB));
  setConfigValue('limit_set_at', new Date().toISOString());
}

// Days/usage summary given current limits and total-used bytes.
// daysLeft/usageLeftBytes are null when unlimited, never negative.
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
  let usagePercentLeft = null;
  if (!unlimitedUsage) {
    const totalBytes = usageLimitGbToBytes(limits.usageGB);
    usageLeftBytes = Math.max(0, totalBytes - totalUsedBytes);
    usagePercentLeft = totalBytes > 0 ? usageLeftBytes / totalBytes : 0;
  }

  return {
    daysLeft,
    usageLeftBytes,
    usagePercentLeft,
    usageUsedBytes: totalUsedBytes,
    usageTotalGB: limits.usageGB,
    unlimitedDays,
    unlimitedUsage,
  };
}

// Builds the value for the "Subscription-Userinfo" response header
// that several client apps (Hiddify, Happ, NekoBox, v2rayN, etc.)
// already know how to parse, to show time/traffic limits natively in
// their own UI instead of a fake config entry in the link list (see
// buildUsageInfoLink() in xray/links.js, which this doesn't replace --
// kept for clients that don't read this header). Standard format:
// "upload=<bytes>; download=<bytes>; total=<bytes>; expire=<unix
// seconds>". A dimension that's unlimited has its field omitted
// entirely -- never sent as total=0/expire=0, since those would read
// as "no quota left"/"expired since 1970" to a parsing client, which
// is the opposite of unlimited.
function buildUserinfoHeader({ uploadBytes, downloadBytes }) {
  const limits = getLimits();
  const parts = [
    `upload=${Math.round(uploadBytes) || 0}`,
    `download=${Math.round(downloadBytes) || 0}`,
  ];

  if (limits.usageGB !== null) {
    parts.push(`total=${Math.round(usageLimitGbToBytes(limits.usageGB))}`);
  }
  if (limits.days !== null) {
    const startedAt = limits.setAt ? new Date(limits.setAt).getTime() : Date.now();
    const expireEpochSeconds = Math.floor((startedAt + limits.days * MS_PER_DAY) / 1000);
    parts.push(`expire=${expireEpochSeconds}`);
  }

  return parts.join('; ');
}

module.exports = { getLimits, setLimits, getUsageSummary, buildUserinfoHeader };
