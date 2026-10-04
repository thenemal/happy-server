# Happy Server

Minimal backend for open-source end-to-end encrypted Claude Code clients.

## What is Happy?

Happy Server is the synchronization backbone for secure Claude Code clients. It enables multiple devices to share encrypted conversations while maintaining complete privacy - the server never sees your messages, only encrypted blobs it cannot read.

## Features

- 🔐 **Zero Knowledge** - The server stores encrypted data but has no ability to decrypt it
- 🎯 **Minimal Surface** - Only essential features for secure sync, nothing more  
- 🕵️ **Privacy First** - No analytics, no tracking, no data mining
- 📖 **Open Source** - Transparent implementation you can audit and self-host
- 🔑 **Cryptographic Auth** - No passwords stored, only public key signatures
- ⚡ **Real-time Sync** - WebSocket-based synchronization across all your devices
- 📱 **Multi-device** - Seamless session management across phones, tablets, and computers
- 🔔 **Push Notifications** - Notify when Claude Code finishes tasks or needs permissions (encrypted, we can't see the content)
- 🌐 **Distributed Ready** - Built to scale horizontally when needed

## How It Works

Your Claude Code clients generate encryption keys locally and use Happy Server as a secure relay. Messages are end-to-end encrypted before leaving your device. The server's job is simple: store encrypted blobs and sync them between your devices in real-time.

## Connecting

This instance is live at **`https://home8.compagnie-lily.org`**.

### Happy mobile app

Settings → **Relay Server URL** → set to `https://home8.compagnie-lily.org`

### Happy web app

Go to `https://app.happy.engineering/server`, set the relay URL to `https://home8.compagnie-lily.org` (no trailing slash), then authenticate.

> A trailing slash causes double-slash URLs (`//v1/...`) that return 404 on every API call.

### Happy CLI

```bash
export HAPPY_SERVER_URL=https://home8.compagnie-lily.org
happy auth login
```

Add to your shell profile to make it permanent:

```bash
echo 'export HAPPY_SERVER_URL=https://home8.compagnie-lily.org' >> ~/.bashrc
```

> **Always set `HAPPY_SERVER_URL` before `happy auth login`** — if it's not set, auth registers against the default upstream server and the web/mobile pairing won't find the request on your server.

### Linux: fix for "Process exited unexpectedly" (running as root)

Remote sessions that die the instant they start are almost always the **root guard**, not a missing binary. The happy SDK launches Claude Code with `--permission-mode bypassPermissions`, and Claude Code refuses that as root:

```
--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons
```

The SDK swallows that stderr, so the session just reports "Process exited unexpectedly". If the daemon legitimately runs as root inside a container, tell Claude Code so:

```ini
# /etc/systemd/system/happy.service.d/env-sandbox.conf
[Service]
Environment=IS_SANDBOX=1
```

```bash
systemctl daemon-reload && systemctl restart happy
systemctl show happy -p Environment   # expect IS_SANDBOX=1
```

Only do this where bypassing interactive permission prompts is actually appropriate — a container, with approvals handled elsewhere.

> **The old musl-symlink workaround is obsolete — do not re-create it.** As of CLI 1.1.10 / agent-sdk 0.3.193 there is no `claude-agent-sdk-linux-x64-musl` package at all; the SDK ships a working glibc binary at `…/claude-agent-sdk-linux-x64/claude`. A symlink into the musl path fixes nothing and hides the real cause.

---

## Setting up a new client machine (VM/LXC)

Full playbook for getting a new dev machine connected to this server.

### Prerequisites

- Node.js + npm
- `claude` CLI already installed (happy wraps it)
- DNS for `home8.compagnie-lily.org` must resolve from the new host — verify before anything else:
  ```bash
  getent hosts home8.compagnie-lily.org
  ```

### 1 — Install happy CLI

```bash
npm install -g happy-coder
happy --version   # sanity check
```

### 2 — Set server URL persistently

Add to `~/.bashrc` (not just the current shell):

```bash
echo 'export HAPPY_SERVER_URL=https://home8.compagnie-lily.org' >> ~/.bashrc
source ~/.bashrc
echo $HAPPY_SERVER_URL   # must print the URL
```

> This must be in the shell rc file. Setting it ad-hoc in one terminal and opening a new tmux pane silently loses it — happy falls back to the default upstream server and auth stalls with no error.

### 3 — Authenticate

```bash
happy auth login --force
```

- Pick **Mobile App**
- **Before scanning the QR**, tail the server log and confirm `POST /v1/auth/request` appears — if nothing shows up, the CLI is still hitting the default upstream, not your server:
  ```bash
  # on the botnificent host:
  docker compose logs happy-server -f
  ```
- Mobile app's **Relay Server URL** must be `https://home8.compagnie-lily.org` — same URL as the CLI. Verify this on mobile **before** scanning, not after.
- Scan the QR, approve on phone → CLI prints "Authentication successful" + machine ID.

### 4 — Start a session

```bash
happy
```

The machine only appears in the mobile app's session list once `happy` is running with no arguments. `happy auth login` alone registers credentials but does not create a visible machine.

### 5 — (Optional) Auto-start on boot with systemd

To have the happy daemon start automatically on boot, create a systemd service:

```ini
# /etc/systemd/system/happy.service
[Unit]
Description=Happy daemon
After=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
User=<your-user>
Environment=HAPPY_SERVER_URL=https://home8.compagnie-lily.org
ExecStart=happy daemon start
ExecStop=happy daemon stop

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now happy
systemctl status happy          # shows "active (exited)" — normal for Type=oneshot
happy daemon status             # confirm the daemon is actually running with PID/port
```

Auth credentials are saved to **`~/.happy/`** (`access.key` plus `settings.json`) on first login and reused on subsequent starts — no interactive login needed at boot. There is no `~/.config/happy/`.

> ⚠️ **That unit alone is not enough in production.** `happy daemon start` forks and returns 0, so systemd reports `active (exited)` even when the daemon died seconds later — one such silent death went unnoticed for 13 days. Before relying on it, add:
>
> - **ordering + readiness** — `After=docker.service` plus an `ExecStartPre` that polls your relay URL, so the daemon doesn't start before the relay answers (its machine registration otherwise times out and the process exits);
> - **a liveness timer** — a 5-minute timer that matches on `happy daemon status` output and restarts the unit when the daemon is gone (use `systemctl restart --no-block`, or the restart can deadlock against the timer's own unit);
> - **log pruning** — happy writes one log per process and never reopens them, so prune by age *and* size *and* count; a long-lived session log can reach hundreds of MB;
> - **a session reaper** — daemon-spawned sessions never exit on their own and are not adopted across a daemon restart, so they leak 150–250 MB each until killed.
>
> Each of these is implemented and explained in `CLAUDE.md` for the `home8` instance, including the traps (systemd eats `${VAR:-default}`; `$$(seq …)` for a literal `$`).

### 6 — Adding the web app to the same account

**Do this after** mobile is working. The web app links to an existing mobile account — it does not create its own account.

1. Go to `https://app.happy.engineering`, hit "New Session" — the web app shows a QR
2. On mobile: open Happy account settings → **Add Device** → scan the web app's QR
3. Web is now on the same account as mobile; all sessions are visible in both

> **Why this order matters:** mobile creates the canonical account. The web app uses an `AccountAuthRequest` flow — it generates a QR, mobile approves it, and web receives a token for mobile's account. If you authenticate web independently (or scan the web QR with the CLI instead of mobile), web and mobile end up on separate accounts with no shared sessions.

### Diagnosing a stalled auth

Work through this order before touching Caddy or the proxy:

1. Mobile app Relay Server URL == `$HAPPY_SERVER_URL` on the CLI (verify both sides)
2. `$HAPPY_SERVER_URL` is in `~/.bashrc`, not just the current shell
3. Tail server logs while the QR is on screen — `POST /v1/auth/request` must appear immediately; if it doesn't, the request is going to the wrong server
4. Only if steps 1–3 are confirmed, investigate the proxy

> **Note on WebSocket testing:** Happy uses Socket.IO (EIO=4 handshake). A bare `curl` with `Upgrade: websocket` will return an empty reply — that's normal, not a proxy error. Don't diagnose Caddy based on raw WebSocket curl tests.

---

## Self-Hosting

### Prerequisites

- Docker + Docker Compose
- A domain name with DNS pointed at your server
- A reverse proxy (Caddy, nginx, etc.) for HTTPS

### Setup

1. **Clone and create your env file:**

   ```bash
   git clone https://github.com/thenemal/happy-server
   cd happy-server
   cp .env.example .env   # then fill in the values
   ```

2. **Generate secrets** and populate `.env`:

   ```
   HANDY_MASTER_SECRET=<openssl rand -hex 32>
   POSTGRES_PASSWORD=<openssl rand -hex 16>
   MINIO_ROOT_USER=minioadmin
   MINIO_ROOT_PASSWORD=<openssl rand -hex 16>
   ```

   > **Keep `HANDY_MASTER_SECRET` safe** — it's used to derive all encryption keys. Losing it means losing access to all stored tokens.

3. **Start the stack:**

   ```bash
   docker compose up -d
   ```

   This starts happy-server (port 3005), PostgreSQL, Redis, and MinIO (port 9000). Database migrations run automatically on startup.

4. **Reverse proxy config** (Caddy example):

   ```
   your-domain.com {
       reverse_proxy localhost:3005
   }

   files.your-domain.com {
       reverse_proxy localhost:9000
   }
   ```

   Set `S3_PUBLIC_URL=https://files.your-domain.com/happy` in your `.env` to match.

5. **Point the Happy app** at `https://your-domain.com`.

### Updating

```bash
git pull
docker compose up -d --build
```

Only the server rebuilds; Postgres, Redis and MinIO keep running. `prisma migrate deploy` runs on container start.

### Keeping up with the clients

The happy CLI and apps ship faster than this fork, and a client calling an endpoint the server lacks just gets a 404 — which the CLI often logs at debug level only, so a feature can be silently dead (session push notifications were, for months). Before upgrading the CLI, diff the client's API surface against the routes this server actually registers:

```bash
npm pack happy@<version> && tar xzf happy-<version>.tgz
# literal routes
grep -rhoE "/v[0-9]+/[a-zA-Z0-9/_.:-]+" package/dist | sort -u
# routes built from template strings — easy to miss
grep -rhoaE "/v1/sessions/\$\{[^}]+\}/[a-z/-]+" package/dist | sort -u
# what this server answers
grep -rhoE "app\.(get|post|put|patch|delete)\('[^']+'" sources/app/api/routes | sort -u
```

Also watch the relay's own 404 log for paths that look like real client calls rather than internet scanners:

```bash
docker compose logs happy-server | grep "404 - Method" | grep "/v[0-9]"
```

Upstream now lives in the [`slopus/happy`](https://github.com/slopus/happy) monorepo under `packages/happy-server/` — the standalone `slopus/happy-server` repo was archived when it was merged there, so a `git fetch` against it returning nothing means nothing.

## License

MIT - Use it, modify it, deploy it anywhere.
