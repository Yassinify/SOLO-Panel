# SOLO Panel

A self-hosted VPN proxy panel for Railway. Deploy it, and it
automatically sets up VLESS + Trojan connections for you — no manual
config, no separate VPS or database needed.

## Getting Started

### 1. Deploy to Railway

Fork this repo, then in Railway: **New Project → Deploy from GitHub
repo** → select your fork. Railway builds it automatically (Node 20,
via Nixpacks) — no setup needed on your part.

### 2. Add persistent storage (important!)

Without this step, **every redeploy wipes your admin password and all
generated connections**, forcing you to start over.

1. In your Railway service, open the **Command Palette**
   (`Ctrl+K` / `⌘K`) and search for **"volume"** → choose **New
   Volume**. (Or right-click the service on the canvas → **Attach
   Volume**.)
2. When asked for a **mount path**, enter:
   ```
   /app/data
   ```
   This is the recommended path — the panel finds it automatically.
3. Redeploy the service so the change takes effect.

### 3. Set your admin password

By default the panel's login password is `admin` — anyone with the
URL could log in. Before sharing your panel, set a real password:

- In Railway, open your service → **Variables** → add a new variable:
  - **Name:** `ADMIN_PASSWORD`
  - **Value:** (a password of your choice)
- Redeploy.

> ⚠️ This only works the *first* time the app starts (before any admin
> account exists). Changing it later has no effect — see [Known
> limitations](#known-limitations) below.

### 4. Open your panel

Once deployed, open your Railway service's public URL in a browser
and sign in. From the dashboard, copy your **Subscription URL** — this
is the one link you paste into any VPN client app (or open in a
browser to see connection status).

That's it — you're done. Everything below is optional background for
anyone who wants to understand how it works or tweak it further.

---

## Env vars

Everything is optional — the panel runs fine with none of these set.

| Variable         | Default                          | Notes |
| ---------------- | --------------------------------- | ----- |
| `ADMIN_PASSWORD` | `admin`                           | Only used the very first time the app starts. See step 3 above. |
| `NODE_ENV`       | unset                              | Set to `production` for secure (HTTPS-only) session cookies. |
| `SESSION_SECRET` | auto-generated                     | Only set this if you need a fixed value shared across multiple instances. |
| `DATA_DIR`       | your Volume's mount path, or `./data` if none | Only set this yourself if you're not using a Railway Volume. |
| `XRAY_VERSION`   | latest release at install time     | Pin a specific version for reproducible builds. |
| `PUBLIC_DOMAIN`  | unset                              | Fallback only — links normally match whatever domain you actually visit. |

`RAILWAY_PUBLIC_DOMAIN` and `RAILWAY_REPLICA_REGION` are set
automatically by Railway; you don't need to touch them.

## Known limitations

- **No password recovery.** `ADMIN_PASSWORD` only sets the password on
  first boot. If you lose it, you'll need to wipe your storage and
  start over (which also resets all generated connections).
- **Changing connection settings briefly disconnects everyone.**
  Toggling a protocol/transport restarts the proxy process.
- **Usage/time limits are informational only.** The dashboard shows
  "X days / Y GB left", but nothing actually blocks traffic once a
  limit is hit.
- **Linux only.** The proxy engine doesn't run on Windows — test
  locally via WSL/Linux, or just deploy to Railway to try it.

## Local development

```bash
cp .env.example .env   # edit as needed -- everything in it is optional
npm install             # also downloads the proxy engine
npm start
```

Then open `http://localhost:3000`. On Windows the admin UI works but
the proxy engine won't actually start (see Known limitations) — use
WSL/Linux, or test on Railway.

## License

MIT — see [LICENSE](LICENSE).
