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

### Happy CLI

```bash
export HAPPY_SERVER_URL=https://home8.compagnie-lily.org happy auth login
```

Add to your shell profile to make it permanent:

```bash
echo 'export HAPPY_SERVER_URL=https://home8.compagnie-lily.org' >> ~/.bashrc
```

> **Always set `HAPPY_SERVER_URL` before `happy auth login`** — if it's not set, auth registers against the default upstream server and the web/mobile pairing won't find the request on your server.

### Linux: fix for "Process exited unexpectedly" (glibc systems)

The happy npm package bundles a musl Claude Code binary for Linux. On glibc systems (Debian, Ubuntu, most LXC containers), the bundled binary is missing and remote sessions crash. Fix by symlinking your system `claude` to the expected path:

```bash
sudo ln -sf ~/.local/bin/claude \
  /usr/local/lib/node_modules/happy/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude
```

Run once after `npm install -g happy` or after any happy upgrade.

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

## License

MIT - Use it, modify it, deploy it anywhere.
