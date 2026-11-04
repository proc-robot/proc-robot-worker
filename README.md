# Proc-Robot — worker

The background worker of **Proc-Robot**, an AI-powered procurement & quotation platform (*from
specification to quotation*). Work that is too slow for a web request is queued by the database and
done here:
- reading a customer's specification;
- importing a supplier's price list;
- searching for prices;
- rendering an RFQ or Sales Quotation to PDF.

**Stack:** Node 22 + TypeScript · Supabase Queues (pgmq) · Docker with LibreOffice headless ·
Railway (US East).

## How it fits

```
Browser ──► proc-robot-web (Next.js) ──► Postgres RPC
                                           │ checks plan and credits, then writes the
                                           │ ai_jobs row + the queue message in one transaction
                                           ▼
                                  Supabase Queues (pgmq)
                                           │ long poll
                                           ▼
                                  proc-robot-worker ──► AI and search APIs, LibreOffice, Storage
                                           │ progress, result or error
                                           ▼
                                  public.ai_jobs ──Realtime──► progress in the browser
```

- **The database is the only link between the web app and the worker.** The web app never runs
  long work, and the worker serves no API to the browser.
- **The worker is confined to one organization per job.** It connects as its own Postgres role,
  `procrobot_worker`, which has **no RLS bypass**. Each job runs in a transaction scoped to the job's
  organization, so a handler can only read and change that organization's rows.
- **Failed jobs are retried** with exponential backoff. After 5 deliveries:
  - the message moves to a dead-letter table;
  - the user sees a plain error message;
  - an alert goes to Slack.
- **A job is not lost if a worker dies.** Its message becomes visible again for another worker, and a
  database cron job (every minute) puts the job back in the queue.

## Queues

| Queue | What it does | Status |
|---|---|---|
| `ping` | End-to-end check from the dashboard: RPC → queue → worker → Realtime → UI | ✅ Built (T0.6.8) |
| `extract` | Extracts line items from an uploaded specification (Excel, CSV, PDF, BOQ) | Phase 1 (T1.3) |
| `import_price_list` | Imports a supplier's price list, with AI column mapping | Phase 1 (T1.4.4) |
| `price_discovery` | Finds prices for confirmed items: own suppliers, the network, online | Phase 1 (T1.5, T1.6) |
| `analyze_template` | Finds the placeholders in an organization's DOCX/XLSX template | Phase 1 (T1.9.7) |
| `render_document` | Fills the template and converts it to PDF with LibreOffice | Phase 1 (T1.9.9) |

The web repo's migrations create the queues. A message on a queue that has no handler yet waits
until the worker learns that queue.

## Getting started

You need:
- Node 22;
- Docker;
- the Supabase CLI (3.0.0, the version CI uses);
- **both repos cloned side by side**, because the database (migrations, seed, worker role) lives in
  the web repo.

```bash
git clone git@github.com:proc-robot/proc-robot-web.git
git clone git@github.com:proc-robot/proc-robot-worker.git

cd proc-robot-web
npm install
npm run db:start        # local Supabase with every migration and the demo seed

cd ../proc-robot-worker
npm install
cp .env.example .env    # local DATABASE_URL for the procrobot_worker role
npm run dev             # runs the worker and restarts it on every change
```

**To see it work:**
1. Start the web app (`npm run dev` in `proc-robot-web`).
2. Sign in as a seeded user (see that repo's README).
3. Press **Run check** on the dashboard's "System check" card. The card follows the `ping` job live
   until the worker finishes it.

For the health endpoint locally, set `HEALTH_PORT=3299` in `.env`, then run
`curl localhost:3299/health`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Runs the worker and restarts it on every change (`tsx watch`) |
| `npm run build` | Compiles to `dist/` |
| `npm start` | Runs the compiled worker; this is what the Docker image runs |
| `npm test` | Integration tests against the local database |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run format` | Formats the code with Prettier (`format:check` only checks) |
| `npm run check` | Typecheck, format check and tests; run it before every commit |

## Configuration

Environment variables are validated at startup in `src/config.ts`. An invalid value stops the
worker with a message naming it. Locally they come from `.env`; on Railway they come from the
service's variables.

| Variable | Needed | What it is |
|---|---|---|
| `DATABASE_URL` | Yes | Connection for the `procrobot_worker` role. Hosted: the Supavisor pooler, transaction mode, port 6543 |
| `ALERT_WEBHOOK_URL` | In hosted environments | Slack-compatible webhook for dead-lettered jobs |
| `WORKER_CONCURRENCY` | No (default 4) | Jobs run at once, across all queues |
| `WORKER_QUEUES` | No (default: all with a handler) | Comma-separated subset, to split queues across services |
| `HEALTH_PORT` | No (default `PORT`) | Port for `GET /health`. Railway sets `PORT`; with neither set, there is no health server |

[`CLAUDE.md`](./CLAUDE.md) → Configuration lists the rest: retries, visibility timeout, polling,
log level and shutdown grace.

## Tests

`npm test` runs a real worker as `procrobot_worker` against the local database. It works on its own
`worker_test` queue, which the test creates and drops, so a dev worker running at the same time
can't take its messages. It covers:
- success;
- retry, then dead letter;
- malformed messages;
- `JobFailedError`;
- crash loops;
- organization scoping.

It needs the local stack (`npm run db:start` in `proc-robot-web`).

The web repo's Playwright suite also starts this worker from `../proc-robot-worker` for its
end-to-end worker check, so keep `npm install` done here.

## Adding a job

1. **In `proc-robot-web`:**
   - a migration that creates the queue (`pgmq.create`) and the RPC that starts the job with
     `private.enqueue_job(...)`;
   - the narrowest grants and a `procrobot_worker` policy for every table the job touches;
   - tests in `supabase/tests/database/08_worker.test.sql`.
2. **Here:** `src/handlers/<queue>.ts`, built with `defineHandler({ queue, payload, run })` (`payload`
   is a Zod schema), and registered in `src/handlers/index.ts`.
3. **Inside the handler:**
   - run tenant queries through `ctx.db(...)`;
   - report progress with `ctx.progress(percent, message)`;
   - throw `JobFailedError(message)` for failures that a retry can't fix;
   - honour `ctx.signal`;
   - make it idempotent, because a message can be delivered twice.

[`CLAUDE.md`](./CLAUDE.md) has the full handler rules.

## Deployment

Railway builds the `Dockerfile`. `railway.json` sets the health check on `/health` and restarts the
service on failure. There is one service per environment (dev, staging, production), all in US East.

- **The image:**
  - Node 22 on Debian slim;
  - LibreOffice headless with Liberation fonts;
  - runs as the non-root `node` user;
  - `tini` is PID 1, so `SIGTERM` reaches Node and LibreOffice child processes are reaped.
- **Shutdown:** on `SIGTERM` the worker stops taking new jobs and gives running jobs time to finish
  (`SHUTDOWN_GRACE_SECONDS`, 25 by default).
- **Health:** `GET /health` returns `200` with the worker id, queues, running jobs and last poll time
  while the poll loop is alive. It returns `503` when the loop has stalled or the worker is shutting
  down.
- **Secrets:** `DATABASE_URL` and `ALERT_WEBHOOK_URL` are set in Railway's variables and never
  committed. The role's password, the pooler connection string and the Railway setup are covered
  step by step in `SETUP_ACCOUNT.md` (§3 and §7).

## CI

GitHub Actions runs on every pull request and on `main`:
- **Typecheck, format, build.**
- **Integration tests** on a fresh local Supabase stack built from `proc-robot-web`'s migrations.
  This job needs the `REPOS_READ_TOKEN` repository secret, which gives read access to the web repo.
  Without it the job is skipped with a notice.
- **Docker image:** builds the production image and runs `soffice --version` and `node --version`
  inside it.

## Security

- The worker never uses the Supabase service-role / secret key.
- Logs hold ids, counts and durations only. They never hold document contents, prices or margins,
  which are confidential to each organization.
- AI and web output is untrusted. It is validated with Zod before anything is written.
- `ai_jobs.error` is shown to the organization's members, so it only ever holds messages written for
  them. Internal details go to the logs and the dead-letter table, which only Super Admins can read.

## Project layout

```
src/
  main.ts          boot, health server, graceful shutdown
  runner.ts        queue loops, concurrency, retries, dead-lettering
  db.ts            connection pool and withOrg(), the per-organization scope
  queue.ts         pgmq: read (long poll), visibility, archive
  jobs.ts          ai_jobs status updates
  dead-letter.ts   giving up on a message
  alert.ts         Slack-compatible alerts
  heartbeat.ts     the worker_heartbeats row
  health.ts        GET /health
  config.ts        environment variables
  log.ts           JSON log lines
  types.ts         handler API: defineHandler, JobContext, JobFailedError
  handlers/        one file per queue
test/              integration tests
Dockerfile         production image (Node 22 + LibreOffice)
railway.json       Railway build and deploy settings
```

## Conventions and docs

- **Branches** are named `phase-<n>/<title>` (e.g. `phase-0/worker-skeleton`).
- **Commit subjects** start with the TASKS.md ids they complete (`T0.7.1: CI workflows`).
- [`CLAUDE.md`](./CLAUDE.md) explains how the worker is built and the rules for handlers. Claude Code
  reads it too.
- **The project documents are not in this repository.** They sit next to the two repos in the
  project folder:
  - `PLAN.md`: architecture;
  - `CORE_FEATURES.md`: features;
  - `TASKS.md`: progress;
  - `SETUP_ACCOUNT.md`: accounts and secrets.
