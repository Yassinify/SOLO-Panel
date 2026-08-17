// Small shared helpers used by views (passed in as EJS locals).
'use strict';

/**
 * Format a byte count as a human-readable string (e.g. "1.3 GB").
 * Matches the binary (1024-based) convention 3x-ui and most VPN
 * panels use for traffic display.
 */
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  const decimals = exponent === 0 ? 0 : 2;

  return `${value.toFixed(decimals)} ${units[exponent]}`;
}

module.exports = { formatBytes };
