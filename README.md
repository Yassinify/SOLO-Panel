# SOLO Panel

A lightweight, self-hosted web panel for managing [Xray-core](https://github.com/XTLS/Xray-core)
VLESS / VMess / Trojan / Shadowsocks inbounds — built specifically to
run on [Railway](https://railway.com) as a single service, no VPS or
external database required.

Inspired by [3x-ui](https://github.com/MHSanaei/3x-ui)'s UI/UX. Unlike
a VPS-based panel, SOLO Panel is designed around Railway's networking
model: every inbound runs as WebSocket over Railway's single public
HTTPS port by default (TLS terminated at Railway's edge), with an
optional raw-TCP mode via Railway's manually-configured TCP Proxy
feature.

## Features

- Session-based admin login (single admin account)
- Create/enable/disable/delete inbounds (vless, vmess, trojan, shadowsocks)
- Per-inbound client management with shareable connection links
- Per-client subscription URLs (`/sub/:token`, base64, importable into client apps)
- Live per-client traffic stats (via Xray's Stats API)
- Optional raw-TCP inbounds via Railway's TCP Proxy
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

SOLO Panel stores its SQLite database and generated xray config under
the directory in the `DATA_DIR` env var. **Without a Railway Volume,
this data is wiped on every redeploy**, including your admin account
and all inbounds/clients.

In your Railway service → **Settings → Volumes → New Volume**, mount
it at a path such as `/app/data`, then set the `DATA_DIR` service
variable (see below) to that same path.

### 4. Set environment variables

Everything below is optional — SOLO Panel works out of the box with
zero variables set (admin/admin login, an auto-generated session
secret, and a temporary ./data directory). In your Railway service →
**Variables**, you only need to add the ones you want to change:

| Variable | Default if unset | Description |
|---|---|---|
| `ADMIN_PASSWORD` | `admin` | Password for the single admin account (no username, password-only login). Change this before sharing your panel's URL with anyone. |
| `SESSION_SECRET` | auto-generated | Random string used to sign session cookies. If unset, the panel generates one itself on first boot and stores it in the database — no need to come up with one yourself. |
| `DATA_DIR` | `./data` | Directory for the SQLite database, generated xray config, and the auto-generated `SESSION_SECRET`. **Set this to your attached Volume's mount path** (step 3), or this data — including your admin account and inbounds — is wiped on every redeploy. |
| `NODE_ENV` | — | Set to `production` so session cookies are marked secure. Recommended for any public deployment. |
| `XRAY_VERSION` | latest release | Pins the xray-core version downloaded during install. If unset, the install script automatically looks up XTLS/Xray-core's actual latest stable GitHub release at install time. |

Railway automatically provides `PORT`; you don't need to set it.

### 5. Deploy

Railway deploys automatically once the repo is connected. On first
boot, the app seeds the single admin account (`admin` /
`ADMIN_PASSWORD`) and creates the SQLite schema under `DATA_DIR`.

Visit your Railway-assigned domain, log in, and create your first
inbound.

### 6. (Optional) Raw-TCP inbounds

WebSocket inbounds work out of the box with no further setup. If you
also want a raw-TCP inbound, create it in the panel first (transport:
"Raw TCP"), note the internal port it shows you, then in Railway:
**Settings → Networking → TCP Proxy → New TCP Proxy**, pointing at
that internal port. Railway assigns an external host:port — paste that
back into the panel on the inbound's detail page.

Raw TCP has no TLS termination from Railway (unlike the HTTPS domain),
so this mode is plaintext at the transport level unless you layer your
own encryption.

## Common mistakes

Real footguns in how the panel works, not just config typos:

- **No Volume attached / `DATA_DIR` not set.** Everything (admin
  account, inbounds, clients, the auto-generated `SESSION_SECRET`) is
  wiped on every redeploy without one. This is the single most common
  way to "lose" a working panel. See step 3 above.
- **Any inbound/client change restarts xray-core, not just the one
  edited.** Adding a client, toggling an inbound, deleting a client —
  all of it calls a full `restart()`, which briefly drops **every**
  active connection on **every** inbound, not only the one you
  touched. Expect a few seconds of downtime across all users each time
  you make a change.
- **Raw-TCP inbounds need a manual two-step setup after creating
  them** (step 6 above): set up a Railway TCP Proxy pointing at the
  internal port shown, then save the external host/port Railway
  assigns back into the panel. Until that second step is done, the
  client's share link is a placeholder string, not a working URI —
  don't hand it out yet.
- **There's no "forgot password" flow, and only one admin account
  exists.** If its password is lost, the only recovery paths are
  editing `password_hash` directly in the SQLite database, or wiping
  `DATA_DIR` and starting over (losing all inbounds/clients too).
- **The xray-core binary download can fail silently.**
  `scripts/install-xray.js` runs on every `npm install`/build and
  intentionally exits with code 0 even if the download fails (so a
  flaky network doesn't break your whole build). If it does fail
  (temporary network issue, or GitHub API rate-limiting the build
  server when `XRAY_VERSION` is unset and it has to look up the latest
  release), the panel itself will start fine, but creating an inbound
  will fail to spawn xray-core. Check your build logs for
  `Failed to install xray-core` if inbounds aren't working after a
  fresh deploy.
- **Two WebSocket inbounds can't share the same path** — the panel
  now rejects this at creation time, but it's worth knowing why: two
  inbounds on the same path would silently misroute one of them's
  clients through the other's xray-core inbound instead of just
  failing loudly.
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
