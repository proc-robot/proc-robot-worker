# Proc-Robot — worker

The background worker of **Proc-Robot**. It runs Supabase Queue (pgmq) jobs that are too long for
a web request (extraction, price discovery, imports, document rendering). Node 22 + TypeScript,
deployed on Railway as a Docker image with LibreOffice headless.

```bash
npm install
cp .env.example .env
npm run dev       # needs the local Supabase stack: `npm run db:start` in ../proc-robot-web
npm run check     # typecheck, format check, integration tests
```

The database it works on (queues, `ai_jobs`, the `procrobot_worker` role) is defined in
`../proc-robot-web/supabase/`. How the worker is built and the rules for handlers are in
[`CLAUDE.md`](./CLAUDE.md); the plan is in `../PLAN.md` and progress in `../TASKS.md` (T0.6).
