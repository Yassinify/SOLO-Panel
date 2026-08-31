# SOLO Panel

Single-service, single-identity Xray-core panel for Railway. One
subscription, zero manual inbound configuration: the panel generates
every VLESS/Trojan x WebSocket/XHTTP/HTTPUpgrade combination on first
boot and fans each out into every ALPN x TLS-fingerprint client
variant. No VPS, no Docker, no external DB, no TCP Proxy setup.

Assumes you already know what VLESS, Trojan, ALPN, and TLS
fingerprinting are, and how Railway's build/deploy model works. If you
don't, this probably isn't the right starting point.

## How it actually works

- **One xray-core process**, spawned as a child process and managed
  by `src/xray/manager.js`. Every inbound listens on
  `127.0.0.1:1000<row id>` with `security: none` -- there is no TLS at
  the xray-core layer. Railway's edge terminates real TLS on the
  service's single public HTTPS domain/port; `src/xray/proxy.js`
  inspects incoming WS `Upgrade` requests and XHTTP HTTP requests by
  path and pipes matching connections to the right internal port.
  Everything else (the admin UI) goes to Express as normal. This is
  the only way to run xray-core inbounds on a PaaS that gives you
  exactly one public port.
- **6 auto-generated inbound rows**: protocols `{vless, trojan}` x
  transports `{ws, xhttp, httpupgrade}`. Credentials are generated
  once per protocol and shared across its 3 transport rows (one VLESS
  UUID, one Trojan password, total). There is no per-client/per-user
  concept and no admin CRUD for inbounds -- `ensureGeneratedInbounds()`
  seeds these 6 rows idempotently on boot and that's the entire
  config surface. If you want more identities, run more Railway
  services.
- **Link fan-out**: each row's share link is generated per (ALPN x
  fingerprint) combination -- `alpn ∈ {http/1.1, h2}`, `fingerprint ∈
  {chrome, firefox, safari, ios, android, randomized}` -- except
  combinations confirmed broken against real clients (`xhttp` +
  `http/1.1` + a browser fingerprint; `xhttp` + `h2` + `android`),
  which are never emitted (`src/xray/links.js`'s `isBrokenCombo`).
  ALPN/fingerprint are client-side hints only; they don't need to
  match anything in xray-core's own config since Railway's edge does
  the actual TLS handshake.
  Remark format: `<region flag> PROTOCOL - TRANSPORT - ALPN -
  Fingerprint`.
- **One subscription URL** (`GET /sub/:subId`, token from
  `getOrCreateGlobalSubscriptionId()`): content-negotiated by
  User-Agent (`isBrowserRequest()` checks for `Mozilla`) -- a browser
  gets an HTML status/link panel (`subscription.ejs`), a client app
  gets the raw base64 link feed. `GET /sub/:subId/raw` is an explicit
  alias to the raw feed for anything already pointed at it.
  Subscription content is filtered to enabled modes (below) and
  ordered by `src/priority.js` (healthy/low-latency first, rows on a
  deprioritized core sort last).
- **Health + recovery, not just display**: `healthMonitor.js` polls
  every enabled row every 15s (core-level `healthCheck()` via xray's
  Stats API + a raw TCP connect to the inbound's internal port for
  latency); `recovery.js` is a small state machine that restarts a
  core after 2 consecutive unhealthy checks (60s cooldown between
  attempts), and deprioritizes it for 30 minutes after 3 failed
  restart attempts instead of retrying forever.
- **Admin dashboard** (`GET /`, password-only session auth): shows
  the combined subscription link/QR and an "Advanced" settings form
  (`POST /settings/advanced`) with two independent things bundled
  into one save:
  - **Modes**: per-value enable/disable checkboxes for
    protocol/transport/ALPN/fingerprint (`src/modes.js`,
    `app_config` keys `mode_<dimension>_<value>`). Each dimension
    must keep at least one value enabled -- a submission that would
    zero one out is rejected server-side, nothing is persisted, no
    core restarts. Disabling a protocol/transport actually stops that
    core config from being generated (`isRowEnabled()` gates both
    `reloadCore()`'s config build and the health poller); disabling
    an ALPN/fingerprint only removes those link variants from output
    (they aren't row attributes).
  - **Time & usage limits**: admin-entered days/GB, display-only
    (`src/subscriptionLimits.js`). Nothing enforces or blocks traffic
    once a limit is exceeded -- it only changes the "X days / Y GB
    left" text shown on the dashboard and the subscription panel.
  Saving restarts xray-core only if the mode selection actually
  changed (`modesChanged` diff check) -- editing only the limits
  fields doesn't interrupt active connections.
- **Traffic accounting**: `xray/statsPoller.js` polls
  `xray api statsquery` every 10s and accumulates uplink/downlink onto
  each row's `up_bytes`/`down_bytes`. Summed across all rows for the
  usage-limit display -- there's one installation identity, so this is
  whole-subscription usage, not per-client.
- **CSRF**: every state-changing POST (`/login`, `/logout`,
  `/settings/advanced`) requires a session-bound `_csrf` token
  (`src/auth.js`'s `requireCsrf`), no external dependency.
- **Storage**: SQLite via `better-sqlite3`, single file at
  `$DATA_DIR/panel.db`. `DATA_DIR` resolution order: `DATA_DIR` env ->
  `RAILWAY_VOLUME_MOUNT_PATH` -> `./data`. Without a Railway Volume
  backing one of the first two, the DB lives in the container's
  ephemeral filesystem and is wiped on every redeploy -- the dashboard
  shows a non-dismissable warning banner when neither env var is set.
- **xray-core binary**: downloaded by `scripts/install-xray.js` as the
  `postinstall` npm script (both local `npm install` and Railway's
  Nixpacks build). Pulls `XTLS/Xray-core`'s actual latest GitHub
  release by default, or an exact tag via `XRAY_VERSION`. Cached
  across Nixpacks builds via `nixpacks.toml`'s `cacheDirectories`, so
  a redeploy on the same resolved version doesn't re-download.
  Non-fatal on failure (won't block `npm install`); if configs don't
  connect after a fresh deploy, check build logs for a failed install
  first.

## Env vars

Everything below is optional -- the panel runs with zero variables set.

| Variable         | Default                          | Notes |
| ---------------- | --------------------------------- | ----- |
| `ADMIN_PASSWORD` | `admin`                           | Password-only login (no username field). Only read on first boot, when `admin_users` is empty -- changing it later does nothing; see "No password recovery" below. |
| `NODE_ENV`       | unset                              | Set to `production` for secure (HTTPS-only) session cookies. `app.set('trust proxy', 1)` is always on, since Railway always terminates TLS at its edge. |
| `SESSION_SECRET` | auto-generated, persisted in `app_config` | Only set this if you need a fixed value across redeploys/instances sharing a DB. |
| `DATA_DIR`       | `RAILWAY_VOLUME_MOUNT_PATH` or `./data` | Set explicitly only if you're not relying on Railway's own Volume-mount env var. |
| `XRAY_VERSION`   | latest GitHub release at install time | Pin for reproducible builds. |
| `PUBLIC_DOMAIN`  | unset                              | Fallback only — generated links normally match whichever domain the request actually came in on (Railway's or a custom domain you've attached in Railway's Settings -> Networking -> Public Networking). Used only if the Host header is ever missing. |
| `RAILWAY_PUBLIC_DOMAIN` | set by Railway            | Last-resort fallback in `externalHostFor()`, after the request's `Host` header and `PUBLIC_DOMAIN`. Not something you set yourself. |
| `RAILWAY_REPLICA_REGION` | set by Railway           | Drives the region flag/name prefixed onto every link remark (`src/utils.js`'s `REGION_FLAGS` -- 4 regions mapped by prefix, globe emoji fallback otherwise). Not something you set yourself. |

## Deploy

1. Fork, then **New Railway project -> Deploy from GitHub repo** ->
   your fork. Nixpacks auto-detects Node 20.
2. **Attach a Volume** to the service (any mount path). Without one,
   every redeploy wipes the admin password, generated UUIDs/passwords,
   and all state.
3. Set `ADMIN_PASSWORD` before you share the panel URL with anyone
   (default is literally `admin`). Everything else is optional.
4. Deploy. `/sub/:subId` (from the dashboard after logging in) is the
   one URL you hand to a client app or open in a browser.

## Known limitations

- **No password recovery path.** `ADMIN_PASSWORD` only seeds the
  account when `admin_users` is empty. Losing it means editing
  `panel.db` directly (`admin_users.password_hash`, bcrypt) or wiping
  `DATA_DIR` and starting over (which also resets every credential).
- **Mode changes restart xray-core.** Toggling any protocol/transport
  drops every active connection across every inbound briefly, not
  just the one you changed -- there's one process, one config file.
- **Usage/time limits are display-only.** Nothing throttles or cuts
  off traffic when a limit is hit.
- **`xray-core` is Linux-only.** The install script pulls
  `Xray-linux-64.zip` unconditionally (Railway's runtime). On Windows
  locally, the panel UI runs but xray-core never actually spawns --
  use WSL/Linux for that part, or just test on Railway.
- **Install can fail silently.** A GitHub-rate-limited or offline
  `npm install` doesn't fail the build (by design, so a broken network
  doesn't brick deploys) -- it just leaves `bin/xray` missing. Check
  build logs for `Failed to install xray-core` if nothing connects
  after a fresh deploy.

## Local development

```bash
cp .env.example .env   # edit as needed -- everything in it is optional
npm install             # also runs scripts/install-xray.js
npm start
```

`http://localhost:3000`. On Windows, xray-core won't actually start
(see above) -- the admin UI and routing logic are still testable, the
proxying isn't.

## Architecture notes

`docs/how-program-work.md` (gitignored, not in the public repo) has
the full design rationale and dated change log if you're working in
the original working copy rather than a fresh clone/fork.

## License

MIT -- see [LICENSE](LICENSE).
