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

⚠️ **`systemctl status happy` is not a liveness check** — see the boot-race section below. Always confirm with `happy daemon status`.

Three drop-ins customize the unit (`/etc/systemd/system/happy.service.d/`, applied in filename order):
- `env-sandbox.conf` → `[Service]\nEnvironment=IS_SANDBOX=1` — **required** so daemon-spawned sessions can run as root (see the root-guard gotcha below). Spawned `claude` processes inherit the daemon's env.
- `reap-orphans.conf` → the `ExecStartPre` orphan reaper (see below).
- `wait-for-relay.conf` → `After=/Wants=docker.service` + an `ExecStartPre` readiness probe (see below).

After editing any of them: `systemctl daemon-reload && systemctl restart happy`.

**First-time auth only:** run `happy auth login` manually once (credentials saved to `~/.happy/` — `access.key` plus `settings.json`; note there is **no** `~/.config/happy/` on this box). After that the service starts headlessly.

#### Boot race: daemon dies before Docker is up, systemd never notices (fix activated 2026-08-18)

> **Status — activated and partially verified 2026-08-18.**
>
> Verified live:
> - daemon runs in `/system.slice/happy.service` (confirmed via `/proc/<pid>/cgroup`) — not a stray session scope
> - readiness probe resolves correctly: `Starting` → `Daemon started successfully` took **5s** (the empty-`$URL` regression would take 5 min — that timing *is* the test)
> - both timers scheduled (`systemctl list-timers 'happy-*'`)
> - watchdog negative path: fired with the daemon healthy, finished in 2s, correctly did **not** restart
> - watchdog positive path, end to end (`happy daemon stop` → `systemctl start happy-health`):
>   ```
>   03:46:09  happy-health starts
>   03:46:11  "happy daemon not running - restarting happy.service"
>   03:46:11  happy-health Finished        <- returned immediately...
>   03:46:16  Daemon started successfully  <- ...while the restart was still running
>   ```
>   That 5-second gap is also the proof `--no-block` works: a blocking restart would have left the two units waiting on each other.
>
> ⚠️ Still unverified:
> - **the boot race itself** — needs a real reboot to prove the `After=docker.service` ordering holds. This is the original bug; everything above only proves the machinery around it.
> - **`happy-logprune.timer`** has not yet fired (first run 00:00 daily)

**The outage:** the machine showed offline in the app for 13 days (2026-08-05 → 2026-08-18) while `systemctl status happy` reported `active (exited)` the entire time. The relay was healthy throughout — all four containers up, local and public both 200. Only the client daemon was dead.

**Two independent defects, both required:**

1. **Ordering.** At the Aug 5 reboot `happy.service` started at `02:43:48`, one second *before* `docker.service` at `02:43:49`. The relay wasn't listening, so the daemon's machine registration hung and died 60s later:
   ```
   [02:45:29] [DAEMON RUN][FATAL] AxiosError: timeout of 60000ms exceeded
              POST https://home8.compagnie-lily.org/v1/machines  (ECONNABORTED)
   [02:45:30] [DAEMON RUN] Process exiting with code: 1
   ```
2. **systemd is structurally blind to this daemon dying.** `happy daemon start` **forks and returns 0**, so `ExecStart` succeeds even as the child exits 1. With `Type=oneshot RemainAfterExit=yes` the unit then reports `active (exited)` forever. **`Restart=on-failure` would not have helped** — there is no failure for systemd to see. That is why 60 seconds of transient became 13 days of silence.

**Fix — ordering alone is not sufficient.** `After=docker.service` only guarantees dockerd is up, which is *not* the same as the happy-server container being past `prisma migrate deploy`, nor Caddy routing. The daemon talks to the **public** URL, so the probe polls that — one request covers DNS, Caddy and happy-server together:

```ini
# /etc/systemd/system/happy.service.d/wait-for-relay.conf
[Unit]
After=docker.service
Wants=docker.service

[Service]
ExecStartPre=/bin/sh -c 'for i in $$(seq 1 60); do \
  curl -sf -o /dev/null --max-time 5 https://home8.compagnie-lily.org && exit 0; sleep 5; done; exit 0'
```

Bounded at 60×5s = 5 min and always exits 0 — a permanently-down relay must not block boot.

⚠️ **Two systemd-specific traps in that one line — don't "clean them up":**
- **The URL is hardcoded deliberately.** systemd runs its *own* expansion over `ExecStartPre` before `/bin/sh` sees the string (single quotes do not prevent this), and it does **not** support `${VAR:-default}`. Writing `${HAPPY_SERVER_URL:-https://…}` makes systemd look for a variable literally named `HAPPY_SERVER_URL:-https://…`, find nothing, and substitute **empty** — `curl ""` then fails all 60 times and burns the full 5 minutes on every boot before starting the daemon anyway, i.e. the original race merely delayed. Note this is invisible to shell-level testing: an interactive shell has `HAPPY_SERVER_URL` exported from `.bashrc`, so the test can never fail.
- **`$$(seq …)`, not `$(seq …)`** — `$$` is how a literal `$` survives systemd's expansion.

**Timing is the cheap way to tell whether the probe resolved:** with the relay up, `systemctl restart happy` should return in well under a second. If it hangs ~5 minutes, the URL expanded to empty.

**Plus a detection path**, because ordering only fixes *this* trigger while systemd stays blind to the daemon dying from any other cause. `happy-health.timer` → `happy-health.service` runs every 5 min (first at `OnBootSec=3min`) and restarts `happy.service` if the daemon is gone. It matches on the `"Daemon is running"` string rather than an exit code, since the CLI's status exit codes are not a contract (`"Daemon is not running"` correctly fails the match).

⚠️ **The health timer is liveness-only by design.** It must **never** run `happy doctor clean` on a schedule — that kills *all* happy processes including live sessions mid-flight. The selective orphan reaper remains the separate #4 follow-up. (It does reap orphans as a side effect when it fires, since restarting the unit runs the existing `reap-orphans` `ExecStartPre` — but only when the daemon is already dead, which is safe.)

⚠️ The watchdog uses `systemctl restart --no-block happy`. **`--no-block` is required, not cosmetic** — a blocking restart issued from inside a unit can deadlock, with the restart job ordered against the still-running `happy-health.service` and each waiting on the other. For the same reason the unit deliberately carries **no** `After=happy.service`.

**Activation (run once; `daemon-reload` must come first or the restart won't see the drop-in):**

```bash
systemctl daemon-reload
systemctl enable --now happy-health.timer happy-logprune.timer
systemctl restart happy              # reparents the daemon into the unit + exercises the new ExecStartPre
systemctl list-timers 'happy-*'      # confirm both timers are scheduled
happy daemon status                  # the real liveness check
journalctl -u happy-health           # see restarts the watchdog performed
```

#### Log growth: prune by age *and* size

`/root/.happy/logs` was found at **1.3 GB across 221 files** on 2026-08-18. happy writes one log per process and never reopens them, so logrotate's rotate-in-place model does not fit — `happy-logprune.timer` (daily) prunes instead.

**Age alone is not enough, and the reason is worth remembering:** the five largest logs (1.15 GB — 90% of the directory) all carried an mtime of `2026-08-02`, the *previous reboot*, because they were orphaned sessions (#4) writing continuously for weeks until the reboot killed them. A 30-day rule would have deleted 206 small files to reclaim just 124 MB and kept every giant one. So there are two rules: `-mtime +30`, and `-size +100M -mtime +3`. A log still being written always has a fresh mtime, so the size rule can never match a live daemon's log.

⚠️ **These logs contain live `Authorization: Bearer` tokens** in dumped axios error objects — treat them as credentials, never paste them into issues or commits.

#### Orphaned-session RAM leak + the `ExecStartPre` reaper (#4)

Remote sessions spawned by the daemon (`happy … claude --started-by daemon`) **never exit on their own**. When the daemon restarts/upgrades (boot, `systemctl restart happy`, `npm i -g happy`), the **new daemon does not adopt the old daemon's sessions** — `happy daemon list` reports *"started by a previous version of the daemon"* while `happy doctor` still lists them under "Daemon-Spawned Sessions". They become orphans (60–250 MB each + child `claude`) that keep pinging the relay (so their `Session.active` stays `true` and the server's 10-min `startTimeout` never reaps them) until killed by hand. This is a **happy CLI/daemon** bug, not a relay bug — a server-side `active=false` flag cannot kill an OS process on the client. Tracked upstream (still open as of 1.1.10): `slopus/happy` #948, #721, #1189, #989, #442. (Separately, the *"Process exited unexpectedly"* / instant-exit symptom #31/#1343 was **not** a musl issue at all — it's the root-guard problem fixed via `IS_SANDBOX=1`; see Known gotchas. Orphans are the opposite failure: sessions that *do* run and never exit.)

**Mitigation in place** — a systemd drop-in reaps orphans on every (re)start, before the fresh daemon comes up:

```ini
# /etc/systemd/system/happy.service.d/reap-orphans.conf
[Service]
ExecStartPre=-/bin/sh -c 'timeout 30 /usr/local/bin/happy doctor clean </dev/null >/dev/null 2>&1 || true'
```

At `ExecStartPre` time the new daemon isn't running yet, so every `--started-by daemon` process is by definition an orphan → safe to `happy doctor clean`. Guards: `timeout 30` (can't hang boot) + `</dev/null` (EOF any prompt) + `|| true` + leading `-` (rc ignored). This only fires **at restart** — it does not reap orphans that pile up *between* restarts. A periodic reaper (systemd timer / cron) is the planned follow-up; until then, `happy doctor clean` is the manual command (kills **all** happy processes — run when nothing is mid-flight). After editing the drop-in: `systemctl daemon-reload`.

### Known gotchas

- **Trailing slash in web app server URL** — causes `//v1/...` double-slash 404s. Enter URL without trailing slash.
- **`HAPPY_SERVER_URL` not set before auth** — CLI registers keypair on the default server; web/mobile (pointing at yours) can't find the auth request. Always set the env var first.
- **`ai-permission-hook` is active** — tool permissions are auto-resolved server-side; the web/mobile "Permissions shown in terminal only" banner is expected and harmless.
- **"Process exited unexpectedly" / daemon sessions die instantly (root guard)** — the daemon runs as **root** in this LXC, and the happy SDK spawns claude with `--permission-mode bypassPermissions` (→ `--dangerously-skip-permissions`). Claude Code refuses that as root: `--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons`, so every daemon-spawned session exits code 1 the moment it tries to think. **Fix:** tell Claude Code it's in a container by setting `IS_SANDBOX=1` in the daemon's systemd environment (drop-in below) — this lifts the root guard. Legitimate here: we *are* in an LXC, and remote-session permissions are handled by happy + `ai-permission-hook`, not interactively. Confirm with `systemctl show happy -p Environment` (should list `IS_SANDBOX=1`).
  - **Diagnosing a fresh variant:** the SDK swallows claude's stderr. To capture the exact failing argv + stderr, shim the bundled binary — `cd /usr/local/lib/node_modules/happy/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64 && mv claude claude.real`, replace `claude` with a `#!/bin/bash` wrapper that appends `"$*"` to a logfile and `exec`s `claude.real "$@" 2> >(tee -a logfile >&2)`, send a message from mobile, read the log, then `mv -f claude.real claude`.
  - **The old musl-symlink workaround is obsolete** — as of CLI 1.1.10 / agent-sdk 0.3.193 there is **no** `claude-agent-sdk-linux-x64-musl` package; the SDK ships a working glibc binary at `…/claude-agent-sdk-linux-x64/claude` (it even prefers the native-installer claude). Do **not** re-create that symlink; the real fix is `IS_SANDBOX=1`.
- **Two happy installs / npm-prefix trap** — on this box `which happy` → `/usr/local/bin/happy` → `/usr/local/lib/node_modules/happy`, but `npm prefix -g` is `/usr` (so `npm i -g happy` writes to `/usr/lib/node_modules/happy`, an **off-PATH** copy that has no effect). Always upgrade the active copy with `npm i -g --prefix /usr/local happy`, then verify `happy --version`. The stray `/usr/lib` copy can be removed with `npm rm -g --prefix /usr happy`.

### Known API version gaps (fixed)

The happy-server codebase can lag behind the CLI/app client versions. Symptoms: `404` on endpoints the clients call. Fixed so far:

| Endpoint | Added | Why needed |
|---|---|---|
| `GET /v3/sessions/:id/messages?after_seq&limit` | 2026-05-09 | CLI v1.1.8+ uses HTTP polling instead of WebSocket for message fetch |
| `POST /v3/sessions/:id/messages` | 2026-05-09 | CLI v1.1.8+ uses HTTP batch insert instead of WebSocket `message` event |
| `DELETE /v1/machines/:id` | 2026-05-12 | App sends delete when user removes an old machine |

**When pulling upstream happy-server updates:** these endpoints are local patches not in upstream. Re-check they still exist after any `git pull` from the upstream repo — they may have been added upstream (great, remove the patch) or silently lost (re-apply from this commit history). Check server logs for 404s if the app misbehaves after an upgrade.

**Client compatibility:** verified 2026-06-26 against happy CLI **1.1.10** (the `slopus/happy-server` relay repo itself has had no new commits since 2026-02-13, so there was nothing to pull — only the *client* moved). The 1.1.10 daemon polls `GET /v3/sessions/:id/messages` and returns 200 against this server — the v3 patch above is still needed and still works.

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
