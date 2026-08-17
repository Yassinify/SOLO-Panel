// Downloads the xray-core binary for linux-amd64 (Railway/Nixpacks
// build target) from the official XTLS/Xray-core GitHub releases and
// extracts it to ./bin/xray. Runs automatically via the package.json
// `postinstall` script during `npm install` (both locally and on
// Railway's Nixpacks build).
//
// If XRAY_VERSION is set, that exact tag is used (pin for reproducible
// builds). If unset, the GitHub API's "latest release" endpoint is
// queried at install time -- this always reflects XTLS/Xray-core's
// actual latest stable tag (GitHub excludes pre-releases/drafts from
// this endpoint by definition), so forks stay current with zero config.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const AdmZip = require('adm-zip');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const ZIP_PATH = path.join(BIN_DIR, 'xray-download.zip');
const BIN_PATH = path.join(BIN_DIR, 'xray');

// Persistent across Railway/Nixpacks builds (declared as a
// cacheDirectories entry in nixpacks.toml's install phase) even though
// `bin/` itself is not -- so a repeat deploy with the same resolved
// xray-core version copies the binary locally instead of re-downloading
// it from GitHub every single build.
const CACHE_DIR = process.env.XRAY_CACHE_DIR || path.join(os.homedir(), '.cache', 'xray-core');

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

async function resolveXrayVersion() {
  if (process.env.XRAY_VERSION) {
    return process.env.XRAY_VERSION;
  }
  console.log('XRAY_VERSION not set, looking up latest Xray-core release from GitHub...');
  const latest = await fetchJson('https://api.github.com/repos/XTLS/Xray-core/releases/latest');
  if (!latest || !latest.tag_name) {
    throw new Error('GitHub API did not return a tag_name for the latest release');
  }
  return latest.tag_name;
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
    console.log(`xray-core already present at ${BIN_PATH}, skipping download.`);
    return;
  }

  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  }

  const xrayVersion = await resolveXrayVersion();
  const cachedBinPath = path.join(CACHE_DIR, `xray-${xrayVersion}`);

  if (fs.existsSync(cachedBinPath)) {
    console.log(`xray-core ${xrayVersion} found in build cache, copying (no download) ...`);
    fs.copyFileSync(cachedBinPath, BIN_PATH);
    fs.chmodSync(BIN_PATH, 0o755);
    console.log(`xray-core ${xrayVersion} installed at ${BIN_PATH}`);
    return;
  }

  const downloadUrl = `https://github.com/XTLS/Xray-core/releases/download/${xrayVersion}/Xray-linux-64.zip`;

  console.log(`Downloading xray-core ${xrayVersion} from ${downloadUrl} ...`);
  await download(downloadUrl, ZIP_PATH);

  console.log('Extracting xray-core binary ...');
  const zip = new AdmZip(ZIP_PATH);
  zip.extractEntryTo('xray', BIN_DIR, false, true);
  fs.chmodSync(BIN_PATH, 0o755);
  fs.unlinkSync(ZIP_PATH);

  // Save a copy into the (build-cached) CACHE_DIR so the next build
  // with the same resolved version can skip the download entirely.
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    fs.copyFileSync(BIN_PATH, cachedBinPath);
  } catch (err) {
    console.warn(`Could not write xray-core to build cache (non-fatal): ${err.message}`);
  }

  console.log(`xray-core ${xrayVersion} installed at ${BIN_PATH}`);
}

main().catch((err) => {
  console.error('Failed to install xray-core:', err.message);
  // Non-fatal: don't break `npm install` / the Railway build if this
  // fails (e.g. offline dev environment). The panel will just fail to
  // spawn xray at runtime with a clear error until this is resolved.
  process.exitCode = 0;
});
