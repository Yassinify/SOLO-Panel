# SOLO Panel

A zero-config, self-hosted VPN/proxy panel that deploys as a single
service on [Railway](https://railway.com) — no VPS, no external
database, no manual setup.

It runs [Xray-core](https://github.com/XTLS/Xray-core), auto-generating
VLESS / Trojan configs over WebSocket, XHTTP, and HTTPUpgrade — all
sharing Railway's single public HTTPS port (TLS terminated at
Railway's edge). No TCP Proxy, no host/port setup.

## Features

- Zero-config: every protocol × transport combination is generated
  automatically on first boot — nothing to create or configure
- One combined subscription URL — opens as a friendly web panel in a
  browser, or imports straight into any VPN client app
- Health monitoring and automatic recovery for every generated config
- Optional admin controls: enable/disable protocols, transports,
  ALPN, and TLS fingerprints; set a subscription time/data limit
- Single admin login, SQLite storage, xray-core binary installed
  automatically — nothing to compile or Dockerize

## Deploy your own copy

1. **Fork this repo** on GitHub.
2. **New Railway project → Deploy from GitHub repo** → select your
   fork. Railway auto-detects the Node.js app.
3. **Attach a Volume** to the service (Command Palette → "New Volume",
   or right-click the service). Any mount path works — Railway injects
   `RAILWAY_VOLUME_MOUNT_PATH` automatically and the panel picks it up.
   **Without this, all data is wiped on every redeploy.**
4. **(Optional) set variables** — the panel works with zero variables
   set, but you'll likely want to change these:

   | Variable         | Default          | What it does                                  |
   | ---------------- | ---------------- | ---------------------------------------------- |
   | `ADMIN_PASSWORD` | `admin`          | Password-only admin login. Change before sharing your panel URL. |
   | `NODE_ENV`       | —                | Set to `production` for secure session cookies. |
   | `SESSION_SECRET` | auto-generated   | Rarely needs setting — persisted automatically. |
   | `DATA_DIR`       | Volume path      | Rarely needs setting — auto-detected from the Volume. |
   | `XRAY_VERSION`   | latest release   | Pin a specific xray-core version.             |

5. **Deploy.** Visit your Railway domain, log in, and your
   subscription link is already there.

## Common mistakes

- **No Volume attached** → everything resets on every redeploy. See
  step 3.
- **No password recovery.** Losing `ADMIN_PASSWORD` means editing the
  database directly or wiping `DATA_DIR` and starting over.
- **xray-core install can fail silently** on a flaky network or GitHub
  rate limit. Check build logs for `Failed to install xray-core` if
  configs aren't connecting after a fresh deploy.

## Local development

```bash
cp .env.example .env   # then edit .env
npm install             # also downloads the xray-core binary
npm start
```

Visit `http://localhost:3000`.

> **Windows:** the downloaded binary is Linux-only (Railway's
> target), so the panel UI works locally but the proxy core won't
> actually start. Use WSL, Linux, or a real Railway deployment to test
> that part.

## Architecture

See `docs/how-program-work.md` in the working copy (gitignored,
internal notes only) for the full design rationale.

## License

MIT — see [LICENSE](LICENSE).
