# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
