# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is happy-server?

This repo is the **relay backend** for the [Happy](https://github.com/slopus/happy) ecosystem — an open-source tool that lets you control Claude Code remotely from mobile/web. It is the self-hosted equivalent of `https://api.cluster-fluster.com`.

### Ecosystem overview

```
Mobile App (iOS/Android) / Web (app.happy.engineering)
         ↕  end-to-end encrypted
    happy-server  ← this repo, running at https://home8.compagnie-lily.org
         ↕
    happy daemon (on dev machine) → wraps `claude` / Claude Code
```

### Client components (separate from this repo)

| Component | Install | Purpose |
|---|---|---|
| `happy` CLI | `npm i -g happy` | Wraps `claude`/`codex`; shows QR to link mobile/web; runs the local daemon |
| `happy-agent` CLI | `npm i -g happy-agent` | Scripted remote control — spawn sessions, send messages, wait for completion |
| Mobile app | iOS / Android stores | View and control sessions remotely; approve permissions; get push notifications |
| Web app | `app.happy.engineering` | Same as mobile but in browser |

### Connecting clients to this server

**CLI** — always set `HAPPY_SERVER_URL` before auth, or sessions register against the default upstream:
```bash
export HAPPY_SERVER_URL=https://home8.compagnie-lily.org
happy auth login
```

Add to `~/.bashrc` to make permanent.

**Mobile app** — Settings → Relay Server URL → `https://home8.compagnie-lily.org`

**Web app** — go to `https://app.happy.engineering/server`, enter `https://home8.compagnie-lily.org` (no trailing slash), then authenticate.

### Linking a machine for the first time

**Correct order — mobile first, then web:**

1. Set `HAPPY_SERVER_URL` on the dev machine, then run `happy auth login --force`
2. **Mobile:** set Relay Server URL → `https://home8.compagnie-lily.org`, then log in and scan the QR from the CLI
3. **Web:** go to `https://app.happy.engineering`, hit "New Session" — it shows a QR and tells you to go to mobile
4. **Mobile:** open Happy account settings → "Add Device" → scan the web app's QR
5. Web is now on the same account as mobile; all sessions visible in both

**Why this order:** mobile authenticates first (creates the canonical account). The web app then uses `AccountAuthRequest` — it generates a QR, mobile approves it, and web gets a token for mobile's account. Doing it the other way (web first, or `happy auth login` QR scanned by web) leaves web and mobile on separate accounts with no shared sessions.

### Auto-starting the daemon on boot

The `happy` daemon runs as a systemd service (`/etc/systemd/system/happy.service`). It starts automatically on boot — no need to run `happy` manually.

```bash
systemctl status happy          # check it's running (shows active (exited) — normal for Type=oneshot)
systemctl restart happy         # restart after config changes
happy daemon status             # check daemon is actually running with PID/port
happy daemon stop               # stop the daemon manually
journalctl -u happy             # service start/stop logs
```

Service is `Type=oneshot RemainAfterExit=yes` with `ExecStart=happy daemon start` / `ExecStop=happy daemon stop`. The daemon itself manages its own process; systemd just triggers start/stop on boot/shutdown.

**First-time auth only:** run `happy auth login` manually once (credentials saved to `~/.config/happy/`). After that the service starts headlessly.

### Known gotchas

- **Trailing slash in web app server URL** — causes `//v1/...` double-slash 404s. Enter URL without trailing slash.
- **`HAPPY_SERVER_URL` not set before auth** — CLI registers keypair on the default server; web/mobile (pointing at yours) can't find the auth request. Always set the env var first.
- **`ai-permission-hook` is active** — tool permissions are auto-resolved server-side; the web/mobile "Permissions shown in terminal only" banner is expected and harmless.
- **"Process exited unexpectedly" on Linux glibc** — happy bundles a musl Claude binary that doesn't exist on Debian/Ubuntu/LXC. Fix once after install: `sudo ln -sf ~/.local/bin/claude /usr/local/lib/node_modules/happy/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude`

### Known API version gaps (fixed)

The happy-server codebase can lag behind the CLI/app client versions. Symptoms: `404` on endpoints the clients call. Fixed so far:

| Endpoint | Added | Why needed |
|---|---|---|
| `GET /v3/sessions/:id/messages?after_seq&limit` | 2026-05-09 | CLI v1.1.8+ uses HTTP polling instead of WebSocket for message fetch |
| `POST /v3/sessions/:id/messages` | 2026-05-09 | CLI v1.1.8+ uses HTTP batch insert instead of WebSocket `message` event |
| `DELETE /v1/machines/:id` | 2026-05-12 | App sends delete when user removes an old machine |

If a future CLI upgrade breaks messaging again, check server logs for 404s on `/v3/` or `/v4/` endpoints and add them to `sessionRoutes.ts`.

## Commands

- `yarn build` — TypeScript type-check (no emit; `tsc --noEmit`)
- `yarn start` — start server via `tsx ./sources/main.ts`
- `yarn test` — run Vitest tests
- `yarn generate` — regenerate Prisma client after schema changes

Local dev dependencies (Docker shortcuts):
- `yarn db` — start local Postgres container
- `yarn redis` — start local Redis container
- `yarn s3` / `yarn s3:init` — start local MinIO and init the `happy` bucket

**Never run migrations yourself** — only `yarn generate` when new types are needed. Migrations are a human responsibility.

## Self-Hosted Deployment (this instance)

Managed via Docker Compose at `/root/happy-server/docker-compose.yml`. Services: `happy-server` (port 3005), `postgres`, `redis`, `minio` (port 9000 API / 9001 console), `minio-init` (one-shot bucket init).

```bash
docker compose up -d          # start / apply compose changes
docker compose logs -f happy-server
docker compose down
```

On startup the container runs `prisma migrate deploy` before `yarn start`. Secrets live in `/root/happy-server/.env` (gitignored).

## Architecture

### Entry point

`sources/main.ts` wires storage → modules → API in order:
1. Connect Postgres (`db.$connect`) and ping Redis
2. `initEncrypt()` — derives key tree from `HANDY_MASTER_SECRET` via `privacy-kit`
3. `initGithub()` — optional; skips if GitHub env vars absent
4. `loadFiles()` — verifies S3/MinIO bucket exists (hard failure if missing)
5. `auth.init()` — starts auth token lifecycle
6. `startApi()`, `startMetricsServer()`, `startTimeout()`

### Source layout

```
sources/
├── main.ts
├── app/              # Application-specific logic
│   ├── api/          # Fastify server, routes/, socket/
│   ├── auth/
│   ├── events/
│   ├── feed/
│   ├── github/
│   ├── kv/
│   ├── monitoring/
│   ├── presence/     # Session activity cache + timeout
│   ├── session/
│   └── social/
├── modules/          # Reusable, non-app-specific
│   ├── encrypt.ts    # Symmetric encryption via privacy-kit KeyTree
│   └── github.ts
├── storage/
│   ├── db.ts         # Prisma client singleton
│   ├── files.ts      # MinIO/S3 client
│   ├── inTx.ts       # Transaction wrapper (see below)
│   ├── redis.ts
│   ├── repeatKey.ts
│   ├── seq.ts
│   └── simpleCache.ts
└── utils/
```

### Key patterns

**Transactions — `inTx` / `afterTx`**: All DB writes use `inTx`, which runs at `Serializable` isolation with automatic retry (up to 3×, backoff 100/200/300 ms) on Prisma P2034 conflicts. Use `afterTx(tx, callback)` to schedule side-effects (event emissions, notifications) that only fire after the transaction commits — never emit events directly inside a transaction.

**Encryption**: `encryptString` / `decryptString` / `encryptBytes` / `decryptBytes` from `@/modules/encrypt` — always use these, never roll your own crypto. Use `privacyKit.encodeBase64` / `decodeBase64` (from `privacy-kit`) instead of `Buffer`.

**Action files**: DB-mutating operations live in dedicated files named `<entity><Action>.ts` (e.g., `friendAdd.ts`) inside the relevant `sources/app/<domain>/` folder. Add a doc comment explaining the logic. Don't return values "just in case" — only return what callers need.

**API routes**: Fastify 5 + Zod for type-safe request/response. All routes under `sources/app/api/routes/`. All operations must be idempotent — clients retry automatically.

**Imports**: Always use `@/` absolute imports (e.g., `import { db } from "@/storage/db"`).

## Code Style

- 4-space indentation
- TypeScript strict mode; prefer `interface` over `type`; avoid enums (use maps)
- Functional style; avoid classes
- Test files: `*.spec.ts` alongside the source file
- No logging unless asked; no transactional wrappers around non-transactional work (e.g., file uploads)

## Environment Variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Prisma Postgres connection string |
| `REDIS_URL` | Redis connection string |
| `HANDY_MASTER_SECRET` | Master secret for all encryption key derivation |
| `PORT` | Listening port (3005) |
| `S3_HOST`, `S3_PORT`, `S3_USE_SSL` | MinIO/S3 endpoint |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_PUBLIC_URL` | MinIO/S3 credentials and public base URL |
| `GITHUB_*` | Optional GitHub OAuth/App integration |
| `DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING` | Enables remote log collection to `.logs/` |

## Debugging

Log files land in `.logs/` named `MM-DD-HH-MM-SS.log`. Always check `date` first — logs use local time.

```bash
# Errors
tail -100 .logs/*.log | grep -E "(error|Error|ERROR|failed)"

# Auth flow
tail -300 .logs/*.log | grep -E "(Token verified|User connected|User disconnected)"

# Session creation
tail -500 .logs/*.log | grep -E "(new-session|Session created)"

# Endpoint traffic
tail -100 .logs/*.log | grep "incoming request"
```

**Common tells:**
- `"Response from the Engine was empty"` → Prisma lost DB connection
- 404 on `/v1/auth/response` → server restarted mid-auth flow
- `"Auth failed - user not found"` → token mismatch or missing user
- Sessions created but not visible in app → mobile not processing socket updates
