// Downloads the sing-box binary for linux-amd64 (Railway/Nixpacks build
// target) from the official SagerNet/sing-box GitHub releases and
// extracts it to ./bin/sing-box. Runs automatically via the package.json
// `postinstall` script during `npm install`, alongside install-xray.js
// (see docs/product-vision.md rule 6: multi-core architecture).
//
// If SINGBOX_VERSION is set, that exact tag (without the leading "v")
// is used. If unset, the GitHub API's "latest release" endpoint is
// queried at install time, mirroring install-xray.js's behavior.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const BIN_DIR = path.join(__dirname, '..', 'bin');
const ARCHIVE_PATH = path.join(BIN_DIR, 'singbox-download.tar.gz');
const EXTRACT_DIR = path.join(BIN_DIR, 'singbox-extract-tmp');
const BIN_PATH = path.join(BIN_DIR, 'sing-box');

// Same build-cache pattern as install-xray.js's CACHE_DIR (see
// nixpacks.toml's install-phase cacheDirectories).
const CACHE_DIR = process.env.SINGBOX_CACHE_DIR || path.join(os.homedir(), '.cache', 'sing-box-core');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'solo-panel-install-script' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchJson(res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`GitHub API request failed: HTTP ${res.statusCode} for ${url}`));
          return;
        }
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`Failed to parse GitHub API response: ${err.message}`));
          }
        });
      })
      .on('error', reject);
  });
}

/** Returns the version string WITHOUT a leading "v" (asset names use e.g. "1.11.6", tags use "v1.11.6"). */
async function resolveSingboxVersion() {
  if (process.env.SINGBOX_VERSION) {
    return process.env.SINGBOX_VERSION.replace(/^v/, '');
  }
  console.log('SINGBOX_VERSION not set, looking up latest sing-box release from GitHub...');
  const latest = await fetchJson('https://api.github.com/repos/SagerNet/sing-box/releases/latest');
  if (!latest || !latest.tag_name) {
    throw new Error('GitHub API did not return a tag_name for the latest release');
  }
  return latest.tag_name.replace(/^v/, '');
}

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(url, (res) => {
        // Follow redirects (GitHub release assets redirect to S3/CDN).
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlinkSync(destPath);
          download(res.headers.location, destPath).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode} for ${url}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      })
      .on('error', reject);
  });
}

async function main() {
  if (fs.existsSync(BIN_PATH)) {
    console.log(`sing-box already present at ${BIN_PATH}, skipping download.`);
    return;
  }

  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  }

  const version = await resolveSingboxVersion();
  const cachedBinPath = path.join(CACHE_DIR, `sing-box-${version}`);

  if (fs.existsSync(cachedBinPath)) {
    console.log(`sing-box ${version} found in build cache, copying (no download) ...`);
    fs.copyFileSync(cachedBinPath, BIN_PATH);
    fs.chmodSync(BIN_PATH, 0o755);
    console.log(`sing-box ${version} installed at ${BIN_PATH}`);
    return;
  }

  // Official asset naming: sing-box-<version>-linux-amd64.tar.gz,
  // containing a top-level sing-box-<version>-linux-amd64/ directory.
  const assetName = `sing-box-${version}-linux-amd64`;
  const downloadUrl = `https://github.com/SagerNet/sing-box/releases/download/v${version}/${assetName}.tar.gz`;

  console.log(`Downloading sing-box ${version} from ${downloadUrl} ...`);
  await download(downloadUrl, ARCHIVE_PATH);

  console.log('Extracting sing-box binary ...');
  fs.mkdirSync(EXTRACT_DIR, { recursive: true });
  // Shell out to `tar` (present on Railway's Linux build image and on
  // modern Windows for local dev) instead of adding a tar-parsing
  // dependency — mirrors install-xray.js's use of adm-zip for the
  // xray-core .zip asset, just via the system tool for .tar.gz.
  await execFileAsync('tar', ['-xzf', ARCHIVE_PATH, '-C', EXTRACT_DIR]);
  const extractedBinPath = path.join(EXTRACT_DIR, assetName, 'sing-box');
  fs.copyFileSync(extractedBinPath, BIN_PATH);
  fs.chmodSync(BIN_PATH, 0o755);
  fs.unlinkSync(ARCHIVE_PATH);
  fs.rmSync(EXTRACT_DIR, { recursive: true, force: true });

  // Save a copy into the (build-cached) CACHE_DIR so the next build
  // with the same resolved version can skip the download entirely.
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    fs.copyFileSync(BIN_PATH, cachedBinPath);
  } catch (err) {
    console.warn(`Could not write sing-box to build cache (non-fatal): ${err.message}`);
  }

  console.log(`sing-box ${version} installed at ${BIN_PATH}`);
}

main().catch((err) => {
  console.error('Failed to install sing-box:', err.message);
  // Non-fatal, same reasoning as install-xray.js: don't break `npm
  // install` / the Railway build if this fails.
  process.exitCode = 0;
});
