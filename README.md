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

### Happy CLI

```bash
export HAPPY_SERVER_URL=https://home8.compagnie-lily.org
```

Or add it to your shell profile to make it permanent.

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
