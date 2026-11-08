# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is happy-server?

This repo is the **deployment config** for Seb's self-hosted **relay backend** of the [Happy](https://github.com/slopus/happy) ecosystem — an open-source tool that lets you control Claude Code remotely from mobile/web. It is the self-hosted equivalent of `https://api.cluster-fluster.com`.

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

**Web app** — open `https://home8.compagnie-lily.org` in a browser: the self-hosted portal is pre-pointed at this relay (see *Self-hosted web portal (#3)*). Alternatively `https://app.happy.engineering/server`, enter `https://home8.compagnie-lily.org` (no trailing slash), then authenticate — but that is cross-site and blocked on the work laptop.

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
> - **`happy-logprune.timer`** has fired daily without error since 2026-09-12 (`journalctl -u happy-logprune`).
>
> ⚠️ Still unverified (as of 2026-10-04):
> - **the boot race itself** — needs a real reboot to prove the `After=docker.service` ordering holds. This is the original bug; everything above only proves the machinery around it. No reboot since 2026-08-05, so this has now been pending ~2 months; it gets tested whenever CT 111 next restarts.

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

**Rule 3 — file count (added 2026-09-13):** every CLI invocation writes its own log, *including* the `happy daemon status` that `happy-health.timer` runs every 5 minutes — ~270 files/day of ~300 bytes, which had reached **7,047 files** by 2026-09-13 (the 30-day rule would have let it plateau near 8,000). Rule: `! -name '*-daemon.log' -size -2k -mtime +7` — tiny one-shot command logs only (status/list/doctor/`resume --help`), never a session or daemon log. First run took the directory from 7,051 → 2,168 files; steady state ≈ 1,900.

⚠️ **The size rule cannot touch a long-lived *tracked* session.** On 2026-09-13 four daemon sessions aged 13–26 days held ~1.5 GB RSS and 105–213 MB logs each, growing ~8 MB/day apiece (a `SESSION_SCANNER` line every 3 s). Their mtime is always fresh and the daemon still lists them, so neither the pruner nor the `ExecStartPre` reaper sees them. Only stopping the session reclaims them — see #4.

⚠️ **These logs contain live `Authorization: Bearer` tokens** in dumped axios error objects — treat them as credentials, never paste them into issues or commits.

#### Orphaned-session RAM leak + the `ExecStartPre` reaper (#4)

Remote sessions spawned by the daemon (`happy … claude --started-by daemon`) **never exit on their own**. When the daemon restarts/upgrades (boot, `systemctl restart happy`, `npm i -g happy`), the **new daemon does not adopt the old daemon's sessions** — `happy daemon list` reports *"started by a previous version of the daemon"* while `happy doctor` still lists them under "Daemon-Spawned Sessions". They become orphans (60–250 MB each + child `claude`) that keep pinging the relay (so their `Session.active` stays `true` and the server's 10-min `startTimeout` never reaps them) until killed by hand. This is a **happy CLI/daemon** bug, not a relay bug — a server-side `active=false` flag cannot kill an OS process on the client. Tracked upstream, **all still open as of 1.2.0 / 2026-08-18**: `slopus/happy` #948, #721, #1189, #989, #442. (#989, *"daemon socket silently dies — no liveness probe or reconnection"*, is essentially the upstream twin of the boot-race outage above; `happy-health.timer` is our local answer to it.)

**Measured cost of one upgrade (2026-08-18).** Upgrading 1.1.10 → 1.2.0 orphaned two sessions in under ten minutes — `happy daemon list` returned the telltale *"No active sessions this daemon is aware of (they might have been started by a previous version of the daemon)"* while `ps` showed them alive:

| PID | Age | RSS |
|---|---|---|
| 2492190 (+ child `claude` 2492213) | 8m | 150 MB + 294 MB |
| 2495847 | 5m | 141 MB |

**~585 MB stranded by a single `npm i -g`.** Combined with the disk finding below, that is the concrete argument for a periodic reaper rather than a restart-only one.

⚠️ **This also leaks disk, not just RAM.** On 2026-08-18 `/root/.happy/logs` had reached 1.3 GB, and the five largest logs (1.15 GB) were orphans that had been writing for **five to six weeks** — filenames dated Jun 26 / Jul 12 / Jul 19, all with an mtime of the Aug 2 reboot that finally killed them. An orphan's cost is its RSS *plus* an unbounded log for as long as it survives. Those logs also contain live `Authorization: Bearer` tokens, so treat them as credentials. See `happy-logprune.timer` above and issue #4. (Separately, the *"Process exited unexpectedly"* / instant-exit symptom #31/#1343 was **not** a musl issue at all — it's the root-guard problem fixed via `IS_SANDBOX=1`; see Known gotchas. Orphans are the opposite failure: sessions that *do* run and never exit.)

**Mitigation in place** — a systemd drop-in reaps orphans on every (re)start, before the fresh daemon comes up:

```ini
# /etc/systemd/system/happy.service.d/reap-orphans.conf
[Service]
ExecStartPre=-/bin/sh -c 'timeout 30 /usr/local/bin/happy doctor clean </dev/null >/dev/null 2>&1 || true'
```

At `ExecStartPre` time the new daemon isn't running yet, so every `--started-by daemon` process is by definition an orphan → safe to `happy doctor clean`. Guards: `timeout 30` (can't hang boot) + `</dev/null` (EOF any prompt) + `|| true` + leading `-` (rc ignored).

✅ **Verified working 2026-08-18** — a `systemctl restart happy` after the 1.2.0 upgrade cleared both real orphans (the ~585 MB above) and reparented the daemon into `/system.slice/happy.service`; both `ExecStartPre` steps returned `status=0` (check with `systemctl show happy -p ExecStartPre`).

⚠️ **An `npm i -g` upgrade leaves the daemon outside systemd.** The version-mismatch self-restart spawns it from *your shell's* session scope, so it ends up in `/user.slice/…/session-N.scope` rather than the unit. Always follow an upgrade with `systemctl restart happy` — which conveniently reaps the orphans the upgrade just created. Confirm with `ps -o cgroup= -p <pid>` (want `/system.slice/happy.service`).

This only fires **at restart** — it does not reap orphans that pile up *between* restarts. The liveness watchdog does **not** cover this: during the 1.2.0 upgrade the daemon was alive and healthy the whole time; it was the *sessions* that leaked. `happy doctor clean` remains the manual sledgehammer (kills **all** happy processes — run when nothing is mid-flight). After editing the drop-in: `systemctl daemon-reload`.

#### Periodic reaper: `happy-reap.timer` (added 2026-10-04, ✅ verified 2026-10-21)

`/usr/local/bin/happy-reap-sessions.sh`, every 30 min (`OnBootSec=5min`), covers what the restart-time reaper cannot — sessions that accumulate *between* restarts. Measured trigger: on 2026-10-04 one tracked session had been alive **5d 20h** holding ~440 MB across its `happy` + child `claude`, and `/root/.happy/logs` was back to **1.0 GB / 2,382 files** (one log alone 582 MB).

Two cases, both only for `--started-by daemon` processes:

| Case | Test | Action |
|---|---|---|
| orphan | pid absent from `happy daemon list` | SIGTERM — the daemon can never adopt it |
| idle | tracked, but no `SessionMessage` newer than `IDLE_DAYS` (default **3**, set in the unit) | SIGTERM |
| in use | tracked with a recent message, **at any process age** | left alone |

⚠️ **Idleness must come from the relay DB, never from process age.** A session legitimately in daily use runs for weeks here — the 5d-20h session above had a message 4h old and is correctly *kept*. The script reads `max(SessionMessage."createdAt")` (falling back to `Session."createdAt"`), i.e. timestamps only; message bodies are E2E-encrypted and never touched.

**Why SIGTERM and not `kill -9`:** the CLI's SIGTERM path calls `POST /v1/sessions/:id/archive`, so the row is marked `active=false` cleanly instead of lingering active until the 10-min server timeout. Verified end to end on 2026-10-04 against an orphan: archive request at `20:56:20.491`, DB `active=false` at `20:56:20.494`. SIGKILL only after a 15s grace, plus a sweep for a child `claude` that outlived its parent.

✅ **The idle branch is confirmed by a natural trigger, not just `IDLE_DAYS=0`.** A session left untouched from 2026-10-18 was kept at 64h/65h/…/71h idle and reaped on the first run past the cutoff — `18:11:23 reaping reason=idle 3d children=[…]`, DB `active=false` at `18:11:23.445`, parent and child both gone. Over the first 17 days the timer logged ~820 runs, **0 errors and exactly 1 reap** — every session in real use was correctly left alone, which is the behaviour that matters most here. `/root/.happy/logs` went 1.0 GB → 78 MB across the same window (the pruner's size rule doing its half once the reaper stopped feeding it giant live logs).

Guards, each of which exists because of a specific failure mode:
- **Daemon down → exit 0 immediately.** With no `daemon list` to compare against, *every* live session would look like an orphan. The `ExecStartPre` reaper owns the restart case.
- **`MIN_AGE_SECONDS` (default 600)** — a session spawned seconds ago may not be registered yet, and would otherwise be killed as an orphan.
- **Only the `node` process is eligible.** A shell wrapper (`bash -c …`, e.g. tmux) carries the same argv; signalling it would SIGKILL the real session through the child sweep and skip the archive call. Found while testing.
- **Relay DB unreachable → idle branch skipped**, orphans still reaped; the script always exits 0 so the timer cannot flap.

⚠️ **Never let a command inside the process loop read stdin.** `docker exec -i` did, swallowing the rest of the `pgrep` list so only the *first* process was ever examined — the script silently did almost nothing. The list is now snapshotted into `$candidates` before the loop and every `docker exec` runs with `</dev/null`.

```bash
DRY_RUN=1 /usr/local/bin/happy-reap-sessions.sh              # decisions only, no signals
DRY_RUN=1 IDLE_DAYS=0 /usr/local/bin/happy-reap-sessions.sh  # proves the idle branch selects
journalctl -u happy-reap -n 20                               # what it reaped and why
systemctl list-timers 'happy-*'
```

### Known gotchas

- **Trailing slash in web app server URL** — causes `//v1/...` double-slash 404s. Enter URL without trailing slash.
- **Web app "Failed to connect to server" on the work laptop is the corporate gateway, not the relay** (diagnosed Sunday, 2026-11-08):
  - The background `GET /` from `app.happy.engineering` gets a **503 `text/html` block page** carrying `P3P: CP="CAO PSA OUR"` and `Expires: 1970`. It has no `via: 1.1 Caddy` and no CORS header.
  - Opening home8 directly in a tab works, and so does the same-origin web app on home10.
  - Tell-tale: any 503 without `via: 1.1 Caddy` didn't come from us.
  - The way around it is the same-origin web portal on home8 — see *Self-hosted web portal (#3)*.
- **`HAPPY_SERVER_URL` not set before auth** — CLI registers keypair on the default server; web/mobile (pointing at yours) can't find the auth request. Always set the env var first.
- **`ai-permission-hook` is active** — tool permissions are auto-resolved server-side; the web/mobile "Permissions shown in terminal only" banner is expected and harmless.
- **"Process exited unexpectedly" / daemon sessions die instantly (root guard)** — the daemon runs as **root** in this LXC, and the happy SDK spawns claude with `--permission-mode bypassPermissions` (→ `--dangerously-skip-permissions`). Claude Code refuses that as root: `--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons`, so every daemon-spawned session exits code 1 the moment it tries to think. **Fix:** tell Claude Code it's in a container by setting `IS_SANDBOX=1` in the daemon's systemd environment (drop-in below) — this lifts the root guard. Legitimate here: we *are* in an LXC, and remote-session permissions are handled by happy + `ai-permission-hook`, not interactively. Confirm with `systemctl show happy -p Environment` (should list `IS_SANDBOX=1`).
  - **Diagnosing a fresh variant:** the SDK swallows claude's stderr. To capture the exact failing argv + stderr, shim the bundled binary — `cd /usr/local/lib/node_modules/happy/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64 && mv claude claude.real`, replace `claude` with a `#!/bin/bash` wrapper that appends `"$*"` to a logfile and `exec`s `claude.real "$@" 2> >(tee -a logfile >&2)`, send a message from mobile, read the log, then `mv -f claude.real claude`.
  - **The old musl-symlink workaround is obsolete** — as of CLI 1.1.10 / agent-sdk 0.3.193 there is **no** `claude-agent-sdk-linux-x64-musl` package; the SDK ships a working glibc binary at `…/claude-agent-sdk-linux-x64/claude` (it even prefers the native-installer claude). Do **not** re-create that symlink; the real fix is `IS_SANDBOX=1`.
- **Two happy installs / npm-prefix trap** — on this box `which happy` → `/usr/local/bin/happy` → `/usr/local/lib/node_modules/happy`, but `npm prefix -g` is `/usr` (so `npm i -g happy` writes to `/usr/lib/node_modules/happy`, an **off-PATH** copy that has no effect). Always upgrade the active copy with `npm i -g --prefix /usr/local happy`, then verify `happy --version`. The stray `/usr/lib` copy can be removed with `npm rm -g --prefix /usr happy`.

### The server is upstream, pinned (#7)

**This repo no longer contains server source.** The relay runs **upstream** `slopus/happy` `packages/happy-server`, built locally from the commit in `UPSTREAM_SHA` by `./build-upstream.sh` into `happy-server:upstream-<short>`. Until 2026-11 this repo was a fork of the standalone `slopus/happy-server`. That repo was archived on 2026-02-14 because it **merged into the monorepo**, not because the project died. The fork's last state is tagged **`fork-final`**, which is how the rollback image gets rebuilt.

**Status:** ✅ cut over at Sunday, 2026-11-08 06:28 UTC, and **verified by Seb** the same day from mobile:
- a long session opens on its newest page
- push arrives while the app is backgrounded
- a stopped session goes inactive

The 3 upstream migrations were applied to prod. The pre-cutover dump is `/root/happy-backups/pre-upstream-2026-11-08.dump`. The old image is kept as `happy-server:fork-38f4b94`. The rehearsal on a restored copy showed the fork image runs fine on the migrated schema, so rollback means changing the compose `image:` to it. Once the upstream image has proven itself for a few weeks, the fork tag and the dumps can go.

**Why the fork was dropped.** Every patch it carried turned out to be a hand-port of something upstream already had:
- v3 messages, including `before_seq` (#15)
- `DELETE /v1/machines/:id`
- `push-event` and the push-suppression presence check (#9)
- `archive` and `clearSessionUpdates` (#9)

Parity was checked route by route on Sunday, 2026-11-08 against `41cdc0a`. The fork's only extra route was `POST /v1/voice/token`, which no client calls. Evidence is in the #7 plan comment.

**Bumping the pin:**
1. Pick a commit, preferably the latest one touching `packages/happy-server`:
   ```bash
   gh api "repos/slopus/happy/commits?path=packages/happy-server&per_page=10" \
     --jq '.[] | "\(.sha[:7]) \(.commit.author.date[:10]) \(.commit.message | split("\n")[0])"'
   ```
2. Check for new migrations. This is the step that matters: list `packages/happy-server/prisma/migrations` at the new SHA against the DB:
   ```bash
   docker compose exec -T postgres psql -U happy -d happy -Atc 'select migration_name from _prisma_migrations order by 1'
   ```
   New ones mean a **human** step: `pg_dump` first, and read every `migration.sql` for anything destructive.
3. Update `UPSTREAM_SHA`, run `./build-upstream.sh`, and update the `image:` tag in `docker-compose.yml`.
4. `docker compose up -d happy-server`. Its command runs `prisma migrate deploy` first, so **the first start of a new image is the migration step.**
5. `systemctl restart happy`, then verify: `happy daemon status`, plus a mobile session open and a push.
6. **Re-verify the web portal** (`https://home8.compagnie-lily.org` in a browser: sessions list, a session opens, live updates). Its client is frozen at `WEB_SHA` while the server moves; see *Self-hosted web portal (#3)*.

**Local patches**, only if upstream truly lacks a fix: put `*.patch` files in `patches/`. `build-upstream.sh` applies them on top of the pin. Keep the directory empty otherwise, because every patch is a re-port waiting to happen.

**Image facts at `41cdc0a`:**
- `Dockerfile.server` needs the whole workspace (root `pnpm-lock.yaml`, `patches/`, `scripts/`, `happy-cli`/`happy-wire` package files), so the script clones the full monorepo to `/root/happy-upstream`.
- Runtime is `node:24` + pnpm 10.11, workdir `/repo/packages/happy-server`.
- `prisma` lives at `/repo/node_modules/.bin`, so use `pnpm exec prisma ...`, not `node_modules/.bin/prisma`.
- It listens on `PORT` (default 3005); the `EXPOSE 3000` is cosmetic.
- Image size is **~5.9 GB**.

**Tests** live upstream (`*.spec.ts` / `*.test.ts` next to the sources). Run them from the builder stage of `/root/happy-upstream`, not here.

**Still missing: attachments.** In S3 mode upstream returns presigned URLs signed for `S3_HOST`, and `S3_HOST=minio` is unreachable from clients. So image attachments still fail, same as before the switch. The fix is upstream's `0f74546` pattern: point `S3_HOST` at a public MinIO hostname through Caddy, preserving the Host header. That is phase 2, tracked in #19.

#### Scheduled upstream watch (cloud routine)

A claude.ai cloud routine, **`happy-server upstream watch`** (`trig_017YePh7geaUJiqC8jQVPYpS`), runs on the 1st of each month at 04:00 America/New_York (`CRON_TZ=America/New_York 0 4 1 * *`, i.e. 08:00 or 09:00 UTC) — it is **not** a local cron or systemd timer, so `crontab -l` / `systemctl list-timers` won't show it. List/inspect it via the `RemoteTrigger` tool (or claude.ai/code/routines). It checks out this repo read-only and emails Seb **only** when something is new: `packages/happy-server` commits in `slopus/happy` over the last 35 days, relevant PRs, new `happy` / `happy-server-self-host` npm versions, or API/protocol/migration changes. Quiet months send nothing.

⚠️ **Until 2026-09-13 it watched the archived `slopus/happy-server`**, so it was structurally incapable of alerting — every "silent" month before that date means nothing. Rewritten that day to target the monorepo, with a baseline embedded in the prompt. **Rewritten again on Sunday, 2026-11-08 for the upstream-image setup.** Its job is now to answer "is a newer upstream worth bumping `UPSTREAM_SHA` to, and does that bring migrations?". New baseline:
- pin `41cdc0a`; last server commit `acc653b` (2026-11-06)
- 39 migrations deployed, newest `20260914090000_add_session_avatars`; any newer migration is flagged with an additive/destructive verdict
- npm `happy` 1.2.6, `happy-server-self-host` 1.1.11
- known and ignored: attachments (phase 2) and open upstream PR #1837

First run on the new prompt: Tuesday, 2026-12-01. **When the baseline moves** (CLI upgrade, an `UPSTREAM_SHA` bump), update the prompt's baseline section too, or it will keep reporting already-known items.

⚠️ **The cloud sandbox cannot use the GitHub API for repos not attached to the routine.** Only `thenemal/happy-server` is attached, so `api.github.com/repos/slopus/happy/...` returns 403 from both `curl` and WebFetch, and the GitHub MCP tools refuse it ("not configured for this session"). What *does* work (verified in the 2026-09-13 test run): **WebFetch on plain `github.com` HTML pages** (`/slopus/happy/commits/main/packages/happy-server`, `/tree/...`, `/pulls?q=...`) and on **`registry.npmjs.org/<pkg>/latest`** (the full package document gets truncated — use `/latest`). The prompt spells these URLs out; don't "simplify" it back to `curl api.github.com`, or the routine will fail and — worse — may read the failure as "nothing new". The prompt also makes a failed fetch an email-worthy event for that reason.

#### There is an official self-host path (simpler than this Compose stack)

`packages/happy-server-self-host` is published to npm as **`happy-server-self-host`** (latest **1.1.11**, 2026-06-10):

```bash
npm install -g happy happy-server-self-host
happy server
```

`happy server` discovers the package and runs the sync server on embedded **PGlite** storage with local-filesystem uploads — **no Postgres, no Redis, no S3** — and writes `settings.serverUrl` so the CLI and daemon target it. That would replace this repo's four-container stack (`happy-server` + `postgres` + `redis` + `minio`). Version 1.1.11 also bundled a web app, but upstream `e46a907d` (2026-11-05) removed `webapp/` from the package along with the app source, so future releases are server-only and do **not** retire the portal (#3).

Caveat before switching: `happy-server-self-host` was still **1.1.11** as of 2026-10-01 while the CLI is already **1.2.5**, so it *lags the client badly* — the same class of gap the old fork kept hitting. Migration also means moving existing Postgres/MinIO data into PGlite/local files — not a drop-in for a running instance with history. Relevant docs in the monorepo: `docs/deployment.md`, `docs/backend-architecture.md`, `docs/api.md`, `docs/protocol.md`, `docs/plans/happy-serve-self-host.md`.

Two gotchas when checking upstream from this repo:
- **Don't re-add an `upstream` remote.** On Sunday, 2026-11-08 the clone had an `upstream` remote pointing at the archived `slopus/happy-server`. `gh` preferred it over `origin`, so a bare `gh issue create` failed with "Repository was archived so is read-only". The remote was removed that day and only `origin` remains. Real upstream is `slopus/happy` (`packages/happy-server/`), and its checkout lives at `/root/happy-upstream`, managed by `build-upstream.sh`. If `gh` ever targets the wrong repo again, check `gh repo view --json nameWithOwner`.
- **`happy --version` is misleading** — it passes through to Claude Code and prints *that* version. For the real CLI version use `node -p "require('/usr/local/lib/node_modules/happy/package.json').version"`, or read `startedWithCliVersion` from `happy daemon status`.

**Client compatibility:** verified 2026-08-18 against happy CLI **1.2.0** (upgraded from 1.1.10 that day). Before upgrading, the API surface of both tarballs was diffed rather than assumed: **9 base endpoints and 7 constructed sub-routes, identical in both** — including the patched `v3/sessions/:id/messages` — and the same `@anthropic-ai/claude-agent-sdk` constraint (`^0.3.179`). Post-upgrade the daemon registers, holds its WebSocket, and the relay answers 200. The v3 patch is still needed and still works.

**Upgraded to 1.2.3 on 2026-09-13 (#8)** ✅ verified by user 2026-09-13 (remote session from mobile works). Tarball API diff vs 1.2.0: identical. Only change of note: agent-sdk constraint `^0.3.179` → `^0.3.259` (installs 0.3.270). Post-upgrade: daemon `startedWithCliVersion 1.2.3`, cgroup `/system.slice/happy.service`, machine registered + WebSocket connected, relay 200. Sequence used (least risky): stop long-lived sessions → `systemctl stop happy-health.timer` (so the watchdog can't race the swap) → `npm i -g --prefix /usr/local happy@1.2.3` → `systemctl restart happy` → verify → re-enable timer. **Rollback:** `npm i -g --prefix /usr/local /root/.happy/rollback/happy-1.2.0.tgz && systemctl restart happy`. (A `pgrep` right after the restart may briefly show a second PID in a `user.slice` session scope — that is the transient `daemon start` launcher, gone within seconds; confirm with `ps -eo pid,cgroup,args | grep happy/dist`.)

**Upgraded to 1.2.6 on 2026-11-08 (#14)** ✅ verified by user 2026-11-08 (restored a session from mobile; daemon resumed it, message answered, push delivered). Pre-check: tarball endpoint diff vs 1.2.3 **identical** (literal + constructed session sub-routes); the bundle contains **no** `session-subscribe` socket event (upstream `5a04b13`, machine-socket session subscription) and **no** avatar calls, so no server change or migration was needed. agent-sdk constraint `^0.3.259` → `^0.3.295` (installs 0.3.319). Same sequence as 1.2.3; no live sessions at the time. Post-upgrade: `startedWithCliVersion 1.2.6`, cgroup `/system.slice/happy.service`, both `ExecStartPre` `status=0`, machine registered + WebSocket connected, relay 200, `happy-health.timer` re-enabled and passing. **Rollback:** `npm i -g --prefix /usr/local /root/.happy/rollback/happy-1.2.3.tgz && systemctl restart happy`.

**Upstream schema at the `41cdc0a` pin** adds 3 migrations on top of the fork's 36. The fork's 36 are byte-identical and checksum-identical to upstream's. All 3 are additive:
- `20260407053500_add_voice_conversation`: new table
- `20260611120000_add_projects`: new table + nullable `Session.projectId`
- `20260914090000_add_session_avatars`: nullable columns + a default

They apply at cutover, which is a human step. **Upstream security PR #1837** (still open) concerns the local-storage `/files/*` route. It only applies if `S3_HOST` is unset, which is why `S3_HOST` is mandatory (see Environment Variables).

⚠️ **The CLI-vs-CLI diff never checks the CLI against *our server*.** It proved 1.2.0 → 1.2.3 changed nothing, but both versions called session sub-routes the old fork lacked (push-event, archive, attachments). When diffing, also compare the constructed routes against the server at the pin: `grep -rhoE "app\.(get|post|put|patch|delete)\('[^']+'" /root/happy-upstream/packages/happy-server/sources/app/api/routes`. The simple `/v[0-9]+/...` grep only shows the literal prefix of template-built routes; find them with `grep -rhoaE "/v1/sessions/\\$\{[^}]+\}/[a-z/-]+" dist`.

Note 1.2.0 was published to **npm only** — GitHub releases stop at `cli-1.1.10`, so there are no changelog notes for it. Diffing the tarball is the only reliable pre-upgrade check. To repeat it: `npm pack happy@<ver>`, unpack, then `grep -rhoE "/v[0-9]+/[a-zA-Z0-9/_.:-]+" dist | sort -u` against the installed copy's `dist`.

## Self-Hosted Deployment (this instance)

Managed via Docker Compose at `/root/happy-server/docker-compose.yml`. Services:
- `happy-server`: the upstream image, port 3005
- `postgres`
- `redis`: also the socket.io streams adapter
- `minio`: port 9000 API / 9001 console
- `minio-init`: one-shot bucket init
- `portal`: same-origin gateway on port 3006 — web app + reverse proxy to `happy-server` (see below)

Secrets live in `/root/happy-server/.env` (gitignored). **Always run compose from `/root/happy-server`.** The project name `happy-server` prefixes the volumes (`happy-server_postgres_data`, ...); running it from another directory, a worktree included, would create a fresh empty stack.

```bash
./build-upstream.sh           # (re)build the pinned image
docker compose up -d          # start / apply compose changes (runs migrate deploy first!)
docker compose logs -f happy-server
docker compose down
```

**Never run migrations yourself.** Migrations are a human responsibility. Because `migrate deploy` is in the start command, a new image with new migrations counts as one. Back up first:

```bash
mkdir -p /root/happy-backups
docker compose exec -T postgres pg_dump -U happy -Fc happy > /root/happy-backups/happy-$(date +%F).dump
```

**Rollback to the fork**, which tolerates the additive upstream schema:
⚠️ **Changing only `image:` crash-loops.** The current `command:` uses `pnpm exec prisma`, and the fork image has no `pnpm`, only `yarn`. Restore the fork's **whole** compose file and swap `build:` for the saved image:

```bash
cd /root/happy-server
git show fork-final:docker-compose.yml | sed 's|^    build: \.|    image: happy-server:fork-38f4b94|' > docker-compose.yml
docker compose up -d happy-server && systemctl restart happy
```

This is safe on the migrated DB. The rehearsal on Sunday, 2026-11-08 showed the fork's `prisma migrate deploy` (prisma 6.11) reports "No pending migrations" against a DB that has the 3 extra upstream migrations, and the fork then served sessions and v3 messages normally. If the `happy-server:fork-38f4b94` tag is gone, rebuild it from a checkout of `fork-final`: `docker build -t happy-server:fork-38f4b94 .`. The rewritten compose was checked with `docker compose config -q`; it has not been run.

Full DB restore (this **loses post-cutover data**): stop `happy-server`, `dropdb`/`createdb`, `pg_restore --no-owner` the dump. Detailed steps are in the #7 plan comment.

### Self-hosted web portal (#3)

**Why:** the work laptop's corporate gateway blocks the cross-site call from `app.happy.engineering` to home8 (see Known gotchas). Serving the web client from home8 itself removes every cross-site request.

**Status:** ⚠️ deployed on :3006 and passing the local test matrix (Sunday, 2026-11-08); the external Caddy flip and Seb's work-laptop test are still pending.

**Pieces:**
- `WEB_SHA` → `c33cc63c` (2026-10-31), the **last** commit of `packages/happy-app`. Upstream deleted the RN/Expo app in `e46a907d` (2026-11-05), so this client is **frozen**. Re-verify it on every `UPSTREAM_SHA` bump.
- `./build-portal.sh` checks `WEB_SHA` out in `/root/happy-upstream` (shared with `build-upstream.sh`; each script resets it to its own pin). It builds upstream's own `Dockerfile.webapp` `--target builder` (`expo export -p web`, ~10 min) with `HAPPY_SERVER_URL=https://home8…` baked in. Then `portal/Dockerfile` copies the export into `caddy:2.10-alpine`, injecting `window.__HAPPY_CONFIG__={"serverUrl":"https://home8…","disableAnalytics":true}` into `index.html`. Result: `happy-portal:web-<short>` (~125 MB); the multi-GB builder image is deleted.
- The client resolves its server as `localStorage custom-server-url` → `__HAPPY_CONFIG__.serverUrl` → build-time default → cluster-fluster. A fresh home8 origin therefore needs no `/server` step.
- `portal/Caddyfile` routing:

| Request | Target |
|---|---|
| `/v1*` (incl. socket.io `/v1/updates`), `/v2*`, `/v3*`, `/files/*`, `/health`, `/logs-combined-…` | `happy-server:3005` (`flush_interval -1`, websockets pass through) |
| `/` with `Accept` containing `text/html` | portal `index.html` |
| `/` otherwise | `happy-server:3005` banner |
| anything else | static file, else `index.html` (SPA fallback) |

⚠️ **`/` must keep serving the banner to non-browser requests.** Server validation (the app's `/server` page, the phone's relay-URL check) does `GET /` with `Accept: text/plain` and requires `Welcome to Happy Server!`; the systemd `wait-for-relay` probe needs a 2xx. An unknown `/v1/x` must stay the API's JSON 404, never `index.html`.

⚠️ **Upstream `HAPPY_STATIC_DIR` is not usable here.** It only works in `standalone.ts`, and our image starts through `main.ts` → `startApi()` with no options. Enabling it would also drop the `/` banner.

**Operate (always scoped, so happy-server is never recreated and `migrate deploy` never reruns):**
```bash
./build-portal.sh
docker compose up -d --no-deps portal
```

**Test matrix** (against `http://localhost:3006`, then `https://home8…`):
- `/` with `Accept: text/html` → HTML containing `__HAPPY_CONFIG__`; with `text/plain` and with `*/*` → banner
- `/v1/does-not-exist` → JSON 404; `/settings` → HTML; an `_expo/.../index-*.js` → 200 JS, immutable cache
- `/v1/updates/?EIO=4&transport=polling` → 200; websocket upgrade → 101
- `POST /v1/auth/account/request` → 200; `OPTIONS` with `Origin: https://app.happy.engineering` → `Access-Control-Allow-Origin` present

**External Caddy (other host, proxmox-manager lane):** home8's upstream moves from CT 111 `:3005` to `:3006`. **Rollback:** point it back at `:3005`. Port 3005 stays published, and nothing else depends on the portal.

**Known risks:**
- The socket.io client is `transports: ['websocket']` only. If the corporate gateway also kills same-origin `wss://`, login works but nothing syncs live. Fix then: patch the bundle at build time to `['polling','websocket']`.
- The bundle references other origins (RevenueCat, Expo, jsdelivr). Those calls fail on the work laptop; none is on the login/QR path.

## Environment Variables

Set in `docker-compose.yml` from `.env`:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Prisma Postgres connection string |
| `REDIS_URL` | Redis. Also enables the socket.io Redis streams adapter that the push-presence check (`fetchSockets()`) uses |
| `HANDY_MASTER_SECRET` | Seeds the encryption KeyTree **and** the auth token generator. **Never change it.** Every client token and every server-encrypted field depends on it |
| `PORT` | 3005 |
| `S3_HOST`, `S3_PORT`, `S3_USE_SSL`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_PUBLIC_URL` | MinIO. **`S3_HOST` is mandatory.** Without it, upstream silently switches to local-disk storage under `DATA_DIR` and serves `/files/*` (upstream PR #1837) |
| `PUBLIC_URL` | Base URL for attachment and avatar URLs (`https://home8.compagnie-lily.org`) |

Deliberately unset:
- `DB_PROVIDER` / `PGLITE_DIR` / `DATA_DIR` / `HAPPY_STATIC_DIR`: standalone mode only
- `ELEVENLABS_API_KEY`: voice stays off
- `GITHUB_*`
- `S3_REGION`: defaults to `us-east-1`
- `METRICS_*`: Prometheus on `:9090` inside the container; harmless

## Debugging

**404s no longer show up in `docker compose logs`.** Upstream `eb980a5c` ("minimize production logs") sets `disableRequestLogging` and log level `error` when `NODE_ENV=production`. The only trace is an aggregate `2xx=/4xx=/5xx=` count in a periodic summary line, with no paths. That breaks the old client-drift check, which relied on seeing a 404 for a route the clients call. To see request paths:
- the **Caddy access log** for home8 (Caddy runs on another host), recommended as the standing replacement (#20)
- temporarily set `DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING=1`, which writes debug-level logs to `.logs/` inside the container, then `docker compose up -d happy-server`

```bash
docker compose logs --since 1h happy-server                      # errors + periodic summary
docker compose exec happy-server sh -c 'tail -200 .logs/*.log'   # only with the debug env var set
```

**Common tells:**
- `"Response from the Engine was empty"` → Prisma lost DB connection
- 404 on `/v1/auth/response` → server restarted mid-auth flow
- `"Auth failed - user not found"` → token mismatch or missing user
- Sessions created but not visible in app → mobile not processing socket updates
