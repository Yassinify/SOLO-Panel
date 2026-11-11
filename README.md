# SOLO Panel: Free Self-Hosted VPN Panel for Railway (Xray-core, VLESS, Trojan)

**SOLO Panel** is an open-source, self-hosted **VPN / proxy panel** that
you deploy to [Railway](https://railway.com) in a few clicks. It runs
[Xray-core](https://github.com/XTLS/Xray-core) for you, creates your
**VLESS** and **Trojan** connections automatically, and gives you **one
subscription link** to paste into your VPN app on phone or computer.

No VPS, no Linux commands, no database to install, and no manual
config files.

**Keywords:** VPN panel, proxy panel, Xray panel, Xray-core panel,
VLESS, Trojan, WebSocket, XHTTP, HTTP Upgrade, subscription link,
Railway deploy, self-hosted VPN, Node.js, open source.

---

## Table of contents

- [What is SOLO Panel?](#what-is-solo-panel)
- [Who is it for?](#who-is-it-for)
- [Features](#features)
- [Quick start: deploy in 4 steps](#quick-start-deploy-in-4-steps)
- [How to use your VPN](#how-to-use-your-vpn)
- [Simple glossary](#simple-glossary)
- [Settings (environment variables)](#settings-environment-variables)
- [Frequently asked questions](#frequently-asked-questions)
- [Known limitations](#known-limitations)
- [Run it on your own computer](#run-it-on-your-own-computer)
- [License](#license)

---

## What is SOLO Panel?

A VPN panel is a small website that controls a VPN server. You log in,
and it shows you the connections your VPN apps can use.

SOLO Panel does three things for you:

1. **Runs the VPN engine** (Xray-core) inside your Railway project.
2. **Creates every connection automatically**: different protocols
   and transports, so you have backups if one stops working.
3. **Gives you a single subscription link.** Paste it into a VPN app
   and all connections are added at once, under the name
   `Solo-Panel`.

## Who is it for?

- People who want their **own private VPN** without renting and
  managing a server.
- Beginners who have never set up a proxy before.
- Anyone who already uses Railway and wants a ready-made Xray panel.

## Features

- **One-click deploy** on Railway - fork the repo and deploy.
- **Zero configuration** - works with no settings at all.
- **Automatic connections** - VLESS and Trojan, over WebSocket, XHTTP
  and HTTP Upgrade, with several TLS fingerprints and ALPN options.
- **One subscription link** that works in VPN apps and also opens a
  readable status page in a normal browser.
- **Mode switches** - turn individual protocols, transports, ALPN
  values or fingerprints on or off from the dashboard.
- **Time and data limits** - set an end date and a data allowance;
  the dashboard and many VPN apps show what is left.
- **Health monitoring and automatic recovery** - the panel checks
  every connection and restarts the engine if it gets stuck.
- **Password-only admin login** with CSRF protection.
- **Mobile-friendly dashboard.**

---

## Quick start: deploy in 4 steps

You need a free [GitHub](https://github.com) account and a
[Railway](https://railway.com) account. No coding is required.

### Step 1 - Deploy to Railway

1. **Fork** this repository (the *Fork* button at the top of this
   page).
2. In Railway, click **New Project → Deploy from GitHub repo** and
   choose your fork.
3. Railway builds and starts the panel by itself (Node 20, via
   Nixpacks). Wait until the deployment shows as successful.

### Step 2 - Add persistent storage (important!)

Without this step, **every redeploy erases your admin password and all
generated connections**, and you would have to start over.

1. In your Railway service, press `Ctrl+K` (`⌘K` on Mac) to open the
   **Command Palette**, search for **volume**, and choose **New
   Volume**. (Alternatively: right-click the service on the canvas →
   **Attach Volume**.)
2. When asked for a **mount path**, enter:
   ```
   /app/data
   ```
3. **Redeploy** the service so the change takes effect.

### Step 3 - Log in and change your admin password

**The default panel password is `admin`.** There is no username:
just the password. Because anyone who finds your URL could try it,
change it right after your first login.

**Option A - change it in the panel (easiest, works any time):**
log in with `admin`, then use the **change password** option on the
dashboard. You will be logged out and can sign in with your new
password.

**Option B - set it before the first start:**

1. In Railway, open your service → **Variables** → **New Variable**.
2. **Name:** `ADMIN_PASSWORD` - **Value:** a password of your choice.
3. **Redeploy.**

> ⚠️ `ADMIN_PASSWORD` is only read the *first* time the panel starts,
> before any admin account exists. If the panel has already run once,
> use Option A instead.

### Step 4 — Open your panel

Open your Railway service's public URL (for example
`https://your-app.up.railway.app`) in a browser and log in. On the
dashboard, copy your **Subscription URL**.

That is all you need. Everything below is optional background.

---

## How to use your VPN

1. Copy the **Subscription URL** from the dashboard.
2. Open your VPN app and add a **subscription** (sometimes called
   *subscription link*, *import from URL*, or *add profile from
   link*). Paste the URL.
3. Update the subscription. The connections appear in the app under
   the name `Solo-Panel`.
4. Pick a connection and connect.

Compatible apps include v2rayNG, v2rayN, Hiddify, Happ, NekoBox,
Streisand and other apps that support standard subscription links.
If one connection does not work on your network, try another.

Opening the same URL in a normal web browser shows a status page
instead: connection health, time left and data left.

---

## Simple glossary

| Term | Plain-English meaning |
| ---- | --------------------- |
| **VPN / proxy** | A service that sends your internet traffic through another server. |
| **Railway** | A hosting platform where you can run apps without managing a server. |
| **Xray-core** | The open-source engine that actually carries your VPN traffic. SOLO Panel starts and controls it. |
| **VLESS, Trojan** | Two VPN protocols: different "languages" between your app and the server. |
| **WebSocket, XHTTP, HTTP Upgrade** | Ways of carrying that traffic so it looks like ordinary web traffic. |
| **ALPN, TLS fingerprint** | Small details of how your app starts a secure connection. Different values help when one is blocked. |
| **Subscription link** | One URL that gives your VPN app a whole list of connections and keeps it updated. |
| **Volume** | Persistent storage on Railway so your data survives redeploys. |

---

## Settings (environment variables)

Everything is optional - the panel runs with none of these set. On
Railway, add them under your service → **Variables**.

| Variable         | Default                                      | What it does |
| ---------------- | -------------------------------------------- | ------------ |
| `ADMIN_PASSWORD` | `admin`                                      | Admin password. Only used the very first time the panel starts. |
| `NODE_ENV`       | unset                                        | Set to `production` for secure (HTTPS-only) session cookies. |
| `SESSION_SECRET` | auto-generated                               | Only set this if you need one fixed value shared by several instances. |
| `DATA_DIR`       | your Volume's mount path, or `./data` if none | Where data is stored. Only set this yourself if you are not using a Railway Volume. |
| `XRAY_VERSION`   | latest release at install time               | Pin a specific Xray-core version for reproducible builds. |
| `PUBLIC_DOMAIN`  | unset                                        | Fallback domain for links. Links normally match the domain you actually visit. |

`RAILWAY_PUBLIC_DOMAIN` and `RAILWAY_REPLICA_REGION` are set
automatically by Railway; you do not need to touch them.

---

## Frequently asked questions

### Is SOLO Panel free?
SOLO Panel itself is free and open source (MIT license). Railway has
its own pricing and free-trial rules, so check their site for what
your usage will cost.

### Do I need a VPS or a domain name?
No. Railway provides the server and a public HTTPS address. You can
optionally attach your own custom domain in Railway.

### How do I add the VPN to my phone?
Copy the **Subscription URL** from the dashboard and add it as a
subscription in a VPN app such as v2rayNG (Android), Streisand
(iPhone), or Hiddify. See [How to use your VPN](#how-to-use-your-vpn).

### What is the default password, and can I change it?
The default panel password is `admin`. After logging in, you can
change it from the dashboard at any time. See
[Step 3](#step-3---log-in-and-change-your-admin-password).

### Why did my admin password reset?
You did not attach a Railway Volume, so storage was wiped on
redeploy. See [Step 2](#step-2---add-persistent-storage-important).

### Can I limit how long or how much data the VPN can be used?
Yes. Set an end date and a data allowance in the dashboard. Leave
them empty for unlimited. These limits are shown to you and in many
VPN apps, but they are informational - see
[Known limitations](#known-limitations).

### Why does the connection drop when I change a setting?
Changing which protocols or transports are enabled restarts the VPN
engine, which briefly disconnects everyone. Change limits only, and
nothing restarts.

### Which VPN protocols does it support?
VLESS and Trojan, carried over WebSocket, XHTTP and HTTP Upgrade,
all served through Railway's single secure HTTPS port.

---

## Known limitations

- **Limits are informational.** The dashboard shows "X days / Y GB
  left", but nothing blocks traffic when a limit is reached.
- **Changing connection modes briefly disconnects everyone**, because
  the proxy engine restarts.
- **Lost password.** `ADMIN_PASSWORD` only applies on first start. If
  you forget your password and cannot log in, you must wipe your
  storage and start over, which also resets all generated
  connections.
- **Linux only.** The proxy engine does not run on Windows. Test via
  WSL or Linux, or simply deploy to Railway.

---

## Run it on your own computer

For developers only - you do not need this to use the panel on
Railway.

```bash
cp .env.example .env   # edit as needed; everything in it is optional
npm install             # also downloads the Xray-core engine
npm start
```

Then open `http://localhost:3000`. On Windows the admin interface
works but the proxy engine will not start, so use WSL/Linux or test
on Railway.

---

## License

MIT - see [LICENSE](LICENSE).
