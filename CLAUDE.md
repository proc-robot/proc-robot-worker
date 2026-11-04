# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**proc-robot-worker** is the background worker of **Proc-Robot**, an AI procurement & quotation
platform. It runs the long work that never happens in a web request: document extraction, price
discovery, price-list imports, template analysis, document rendering (DOCX/XLSX → PDF with
LibreOffice) and, from P2, email. Node 22 + TypeScript, deployed as a Docker service on **Railway
(US East)**.

Sibling repos and docs (one level up, `../`):

| Path | What it is |
|---|---|
| `../proc-robot-web/` | Next.js app **and the database** (`supabase/`: migrations, seed, pgTAP tests). Its `CLAUDE.md` has the database rules |
| `../PLAN.md` | Architecture: "Background jobs" and "AI layer" sections drive this repo |
| `../CORE_FEATURES.md` | What each job does for the user |
| `../TASKS.md` | Checklist. T0.6 built this skeleton; the handlers come with Phase 1 (T1.3 extraction, T1.4.4 imports, T1.5/T1.6 discovery, T1.9 rendering) |

## How it works

1. A **Postgres RPC** (in `../proc-robot-web/supabase/migrations/`) validates the request, reserves
   credits and calls `private.enqueue_job(org_id, queue, payload, credits)`. That writes a row in
   `public.ai_jobs` and sends a pgmq message `{ job_id, organization_id, payload }` in the same
   transaction.
2. **This worker** long-polls each queue (`src/runner.ts`), runs the queue's handler, reports
   progress on `ai_jobs` (the UI follows it over Realtime), and archives the message on success.
3. **Failures** are retried with exponential backoff (the message becomes visible again); after
   `JOB_MAX_ATTEMPTS` deliveries the message goes to `public.jobs_dead_letter`, the job is marked
   failed for the user, and an alert fires (`src/dead-letter.ts`, `src/alert.ts`).
4. While a job runs, the worker extends the message's visibility timeout and the job's
   `heartbeat_at`. If the worker dies, the message reappears for another worker, and the database's
   stale-job sweeper (pg_cron, every minute) puts the job row back to `queued`.
5. Each process keeps a row in `public.worker_heartbeats` and serves `GET /health`.

## The database contract

The worker owns no schema. Queues, `ai_jobs`, `jobs_dead_letter`, `worker_heartbeats`, the
`procrobot_worker` role and its policies are defined in `../proc-robot-web/supabase/migrations/`
(`*_jobs.sql`, `*_worker.sql`) and tested in `supabase/tests/database/08_worker.test.sql`. **Change
the contract there first** (a new migration + test), then here.

## Rules

1. **The worker connects as `procrobot_worker`**, never with the service-role / secret key. The role
   has no RLS bypass.
2. **Every tenant query goes through `ctx.db(fn)`** (`withOrg` in `src/db.ts`): a transaction that
   sets `app.worker_org_id` to the job's organization, so the role's policies only show and change
   that organization's rows. Never use `pool.query` for tenant data, and never set
   `app.worker_org_id` yourself. Only queue operations (`src/queue.ts`) and heartbeats run outside it.
3. **A table the worker needs** gets, in a web-repo migration: the narrowest grant to
   `procrobot_worker`, a policy `to procrobot_worker using (organization_id = (select
   private.worker_org_id()))`, and a test in `08_worker.test.sql`. Cross-organization work (network
   price search, P3 benchmarks) goes through a `security definer` SQL function written for exactly
   that purpose — never a broad grant.
4. **Handlers** live in `src/handlers/`, one file per queue, built with
   `defineHandler({ queue, payload: zodSchema, run(ctx) })` and registered in
   `src/handlers/index.ts`. The queue itself is created by a migration (`pgmq.create`), and the RPC
   that enqueues it lives in the web repo.
5. **Errors:**
   - Throw `JobFailedError(messageForTheUser)` when retrying cannot help (an unreadable file, a
     document with no items). The job fails at once with that message.
   - Any other error is retried, then dead-lettered.
   - `ai_jobs.error` is shown to the organization's members, so it only ever holds messages written
     for them. Internal details go to logs and `jobs_dead_letter`, which only Super Admins read.
6. **Handlers must be idempotent.** A message can be delivered again, e.g. if the worker dies after
   the work but before the archive. Upsert or replace by job id, and check the job's state first.
7. **Progress:** `ctx.progress(percent, shortMessage)`. The message is user-facing.
8. **Honor `ctx.signal`** in long steps (AI calls, LibreOffice): it is aborted on shutdown.
9. **Logs** (`ctx.log`, JSON lines): ids, counts and durations only. Never log payloads, document
   text, prices or margins — they are confidential to the organization.
10. **AI and web content is untrusted input** (prompt injection, PLAN.md → AI safety). Validate every
    model output with Zod before it touches the database.
11. **Credits:** return `creditsConsumed` (and token usage / cost) in the handler's outcome; settling
    the reservation is T1.10.3.

## Commands

```bash
npm install
cp .env.example .env     # local DATABASE_URL (the local password is in ../proc-robot-web/supabase/seed.sql)
npm run dev              # watch mode; needs the local Supabase stack: `npm run db:start` in ../proc-robot-web
npm run build            # tsc → dist/
npm start                # node dist/main.js
npm run check            # typecheck + format:check + test
npm test                 # integration tests against the local database (one file at a time)
npm run format
```

The tests (`test/runner.test.ts`) run a real `Runner` as `procrobot_worker` on their own queue
(`worker_test`, created and dropped by the test), so a dev worker on the `ping` queue cannot take
their messages. They cover success, retry → dead letter, malformed messages, `JobFailedError`, crash
loops (too many deliveries) and org scoping.

The web repo's Playwright suite starts this worker from `../proc-robot-worker` for its end-to-end
worker check, so keep `npm install` done here.

## Configuration

All environment variables are validated in `src/config.ts`; `.env` is read only when present.

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | — | `procrobot_worker` connection. Hosted: Supavisor pooler, transaction mode (`procrobot_worker.<project-ref>` on port 6543) |
| `WORKER_ID` | `<hostname>-<pid>` | Shown in heartbeats, logs and results |
| `WORKER_CONCURRENCY` | 4 | Jobs at once, across all queues |
| `WORKER_QUEUES` | all with a handler | Comma-separated subset |
| `JOB_MAX_ATTEMPTS` | 5 | Deliveries before the dead-letter table |
| `JOB_VISIBILITY_TIMEOUT_SECONDS` | 60 | Extended every third of it while a job runs |
| `JOB_RETRY_BASE_SECONDS` | 30 | Backoff = base × 2^(attempt−1), at most 10 minutes |
| `POLL_SECONDS` | 5 | Long-poll window per read |
| `HEALTH_PORT` | `PORT` | `GET /health`; Railway sets `PORT` |
| `ALERT_WEBHOOK_URL` | — | Slack-compatible webhook for dead letters |
| `LOG_LEVEL` | info | debug, info, warn, error |
| `SHUTDOWN_GRACE_SECONDS` | 25 | Time for running jobs after SIGTERM |

## Deploying (Railway, TASKS.md T0.6.7)

Creating the Railway project and every value it needs is described step by step in
`../SETUP_ACCOUNT.md` (§3 for the database role and connection string, §7 for Railway).

- One service per environment (dev, staging, prod) in US East, built from this repo's `Dockerfile`.
  Config as code in `railway.json`: health check on `/health`, restart on failure.
- The image is Node 22 on Debian with LibreOffice headless (no GUI) and Liberation fonts (metric
  compatible with Arial, the default templates' fallback); `tini` is PID 1, so SIGTERM reaches Node
  and LibreOffice child processes are reaped.
- Per environment, set the role's password once in the Supabase SQL editor
  (`alter role procrobot_worker with password '…'`). Then put `DATABASE_URL` and
  `ALERT_WEBHOOK_URL` in Railway variables. Never commit them.
- The full image (Node + LibreOffice) has not been built locally yet; the first Railway or CI build
  is its first real build.

## Code map

| File | Role |
|---|---|
| `src/main.ts` | Boot: config, pool, runner, heartbeat, health server, SIGTERM handling |
| `src/runner.ts` | Queue loops, concurrency, retries, dead-lettering, visibility heartbeats |
| `src/db.ts` | Pool, `inTransaction`, **`withOrg`** (the org scoping guard) |
| `src/queue.ts` | pgmq: read (long poll), set visibility, archive, delete |
| `src/jobs.ts` | `ai_jobs` status changes (all org-scoped) |
| `src/dead-letter.ts`, `src/alert.ts` | Giving up on a message; alerts |
| `src/heartbeat.ts`, `src/health.ts` | `worker_heartbeats` row; `GET /health` |
| `src/types.ts` | Handler API: `defineHandler`, `JobContext`, `JobOutcome`, `JobFailedError` |
| `src/handlers/` | One file per queue; `ping` is the end-to-end check (T0.6.8) |

## Git

**CI** (`.github/workflows/ci.yml`) runs on every pull request and on `main`:
- `checks`: typecheck, format, build.
- `integration`: the tests on a local Supabase stack built from `proc-robot-web`'s migrations. It
  takes the web repo's branch with **the same name** if there is one, otherwise its `main`. This
  needs the `REPOS_READ_TOKEN` secret (`../SETUP_ACCOUNT.md` §2) and is skipped without it.

**A change that spans both repos** (e.g. a new queue and RPC in the web repo, its handler here) uses
the same branch name in both repos, so each repo's CI tests the pair.
- `docker`: builds the production image and runs `soffice --version` in it.

Same convention as `../proc-robot-web`: branches `phase-<n>/<title>` (e.g. `phase-0/worker-skeleton`),
and commit subjects that start with the TASKS.md ids they complete (`T0.6.1–T0.6.8: Worker skeleton`).
Never commit unless asked.
