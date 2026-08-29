# SOLO Panel

A lightweight, self-hosted web panel for managing [Xray-core](https://github.com/XTLS/Xray-core)
VLESS / VMess / Trojan / Shadowsocks inbounds — built specifically to
run on [Railway](https://railway.com) as a single service, no VPS or
external database required.

likea VPS-based panel, SOLO Panel is designed entirely around Railway's
networking model: every inbound runs as WebSocket, XHTTP, or
HTTPUpgrade over Railway's single public HTTPS port (TLS terminated at
Railway's edge) — no TCP Proxy, no manual host/port setup, ever.

## Features

- Fully zero-config: on first boot the panel auto-generates one Xray
  inbound for every (protocol x transport) combination — VLESS,
  VMess, Trojan, Shadowsocks x WS, XHTTP, HTTPUpgrade — and one
  combined subscription link exposing every (ALPN x TLS fingerprint)
  variant of each. Nothing to create, toggle, or configure.
- Session-based admin login (single admin account)
- One combined subscription URL (`/sub/:token`, base64, importable into client apps)
- Live per-inbound traffic stats (via Xray's Stats API)
- SQLite storage (no external database needed)
- xray-core binary downloaded automatically on install (no Docker needed)

## Deploying your own copy

### 1. Fork this repository

Fork it on GitHub into your own account.

### 2. Create a new Railway project from your fork

In the [Railway dashboard](https://railway.com/new): **New Project →
Deploy from GitHub repo** → select your fork. Railway detects the
Node.js app automatically (Nixpacks builder, already configured in
`railway.json`).

### 3. Attach a Volume (required — do this before first deploy if possible)

SOLO Panel stores its SQLite database and generated xray config on
disk. **Without a Railway Volume, this data is wiped on every
redeploy**, including your admin account and all inbounds/clients.

In the Railway dashboard, add a Volume to this service (use the
Command Palette, or right-click the service on the project canvas —
Railway's UI for this has moved around over time, so if you don't see
a "Volumes" tab under Settings, look for "Add Volume"/"New Volume" via
the command palette or right-click menu instead) and give it any
mount path, e.g. `/app/data`. **No `DATA_DIR` variable needs to be set
manually** — Railway automatically injects `RAILWAY_VOLUME_MOUNT_PATH`
once a Volume is attached, and the panel picks that up on its own. You
only need to set `DATA_DIR` yourself if you want to override that
default for some reason (see below).

### 4. Set environment variables

Everything below is optional — SOLO Panel works out of the box with
zero variables set (admin/admin login, an auto-generated session
secret, and a temporary ./data directory). In your Railway service →
**Variables**, you only need to add the ones you want to change:

| Variable         | Default if unset                      | Description                                                                                                                                                                                                                                                                                                         |
| ---------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_PASSWORD` | `admin`                               | Password for the single admin account (no username, password-only login). Change this before sharing your panel's URL with anyone.                                                                                                                                                                                  |
| `SESSION_SECRET` | auto-generated                        | Random string used to sign session cookies. If unset, the panel generates one itself on first boot and stores it in the database — no need to come up with one yourself.                                                                                                                                            |
| `DATA_DIR`       | auto (Volume mount path, or `./data`) | Directory for the SQLite database, generated xray config, and the auto-generated `SESSION_SECRET`. Normally you don't need to set this — once you attach a Volume (step 3), Railway's own `RAILWAY_VOLUME_MOUNT_PATH` is picked up automatically. Only set `DATA_DIR` explicitly if you need to override that path. |
| `NODE_ENV`       | —                                     | Set to `production` so session cookies are marked secure. Recommended for any public deployment.                                                                                                                                                                                                                    |
| `XRAY_VERSION`   | latest release                        | Pins the xray-core version downloaded during install. If unset, the install script automatically looks up XTLS/Xray-core's actual latest stable GitHub release at install time.                                                                                                                                     |

Railway automatically provides `PORT`; you don't need to set it.

### 5. Deploy

Railway deploys automatically once the repo is connected. On first
boot, the app seeds the single admin account (`admin` /
`ADMIN_PASSWORD`) and creates the SQLite schema under `DATA_DIR`.

Visit your Railway-assigned domain and log in — every inbound and the
combined subscription link are already there, generated automatically.
No further setup is needed; there's no raw-TCP mode (it would need its
own Railway-assigned port, incompatible with the single-domain design).

## Common mistakes

Real footguns in how the panel works, not just config typos:

- **No Volume attached.** Everything (admin account, inbounds,
  clients, the auto-generated `SESSION_SECRET`) is wiped on every
  redeploy without one. This is the single most common way to "lose"
  a working panel. See step 3 above — you don't need to set `DATA_DIR`
  yourself, but you do need to actually attach the Volume.
- **There's no "forgot password" flow, and only one admin account
  exists.** If its password is lost, the only recovery paths are
  editing `password_hash` directly in the SQLite database, or wiping
  `DATA_DIR` and starting over (losing all inbounds too).
- **The xray-core binary download can fail silently.**
  `scripts/install-xray.js` runs on every `npm install`/build and
  intentionally exits with code 0 even if the download fails (so a
  flaky network doesn't break your whole build). If it does fail
  (temporary network issue, or GitHub API rate-limiting the build
  server when `XRAY_VERSION` is unset and it has to look up the latest
  release), the panel itself will start fine, but xray-core will fail
  to spawn. Check your build logs for `Failed to install xray-core` if
  configs aren't working after a fresh deploy.
- **`NODE_ENV=production` isn't set automatically.** Without it,
  session cookies aren't marked `secure`. Functionally the panel still
  works on Railway's HTTPS domain either way, but it's a best-practice
  gap worth closing for any public deployment (see step 4 above).

## Local development

```bash
cp .env.example .env   # then edit .env
npm install             # also downloads the xray-core binary
npm start
```

Visit `http://localhost:3000`.

> **Windows note:** `npm install` downloads the Linux xray-core binary
> (Railway's build target), which won't execute on Windows. The panel
> UI (login, dashboard, database) still works locally, but creating an
> inbound will fail to actually spawn xray-core. Full inbound testing
> needs Linux, WSL, or a real Railway deployment.

## Architecture

See `docs/how-program-work.md` in this repo's working copy for the
full design rationale (Railway networking constraints, single-port
sharing, xray-core process management). That file is intentionally
kept out of the public repo (`.gitignore`) as internal project notes —
ask if you'd like a public-facing version.

## License

MIT — see [LICENSE](LICENSE).
