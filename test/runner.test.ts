import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEAD_LETTER_USER_MESSAGE } from "../src/dead-letter.js";
import { createPool, type Pool } from "../src/db.js";
import { ping } from "../src/handlers/ping.js";
import { silentLogger } from "../src/log.js";
import { Runner, type RunnerOptions } from "../src/runner.js";
import { defineHandler, JobFailedError, type JobHandler } from "../src/types.js";

/**
 * Integration tests against the local Supabase database (`npm run db:start`
 * in ../proc-robot-web). Jobs are enqueued exactly as RPCs do it
 * (private.enqueue_job) and run by a real Runner connected as
 * procrobot_worker. They use their own queue, so a dev worker running on
 * the `ping` queue cannot pick their messages up.
 */
if (existsSync(".env")) process.loadEnvFile(".env");
const WORKER_URL =
  process.env.DATABASE_URL ?? "postgresql://procrobot_worker:worker-local@127.0.0.1:54322/postgres";
const ADMIN_URL =
  process.env.TEST_ADMIN_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const QUEUE = "worker_test";
const OPTIONS: RunnerOptions = {
  WORKER_ID: "test-worker",
  WORKER_CONCURRENCY: 2,
  JOB_MAX_ATTEMPTS: 2,
  JOB_VISIBILITY_TIMEOUT_SECONDS: 5,
  JOB_RETRY_BASE_SECONDS: 0,
  POLL_SECONDS: 1,
  ALERT_WEBHOOK_URL: undefined,
};

let admin: pg.Pool;
let worker: Pool;
let orgA: string;
let orgB: string;

const testPing = { ...ping, queue: QUEUE } as JobHandler<unknown>;

async function enqueue(org: string, payload: Record<string, unknown> = {}): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    "select private.enqueue_job($1, $2, $3::jsonb) as id",
    [org, QUEUE, JSON.stringify(payload)],
  );
  return rows[0]!.id;
}

async function job(id: string) {
  const { rows } = await admin.query("select * from public.ai_jobs where id = $1", [id]);
  return rows[0];
}

/** Runs a worker until `done` holds (or 15 s pass), then stops it. */
async function runUntil(handlers: JobHandler<unknown>[], done: () => Promise<boolean>) {
  const runner = new Runner(worker, handlers, OPTIONS, silentLogger);
  runner.start();
  try {
    const deadline = Date.now() + 15_000;
    while (!(await done())) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the worker");
      await sleep(100);
    }
  } finally {
    await runner.stop(5);
  }
}

const finished = (id: string) => async () =>
  ["succeeded", "failed"].includes((await job(id))?.status);

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  worker = createPool(WORKER_URL, 6, silentLogger);
  await admin.query("select pgmq.create($1)", [QUEUE]);
  const suffix = Date.now().toString(36);
  const { rows } = await admin.query<{ id: string }>(
    `insert into public.organizations (name, slug, country, default_currency)
     values ($1, $2, 'SG', 'SGD'), ($3, $4, 'ID', 'IDR') returning id`,
    [
      `Worker Test A ${suffix}`,
      `worker-test-a-${suffix}`,
      `Worker Test B ${suffix}`,
      `worker-test-b-${suffix}`,
    ],
  );
  orgA = rows[0]!.id;
  orgB = rows[1]!.id;
});

afterAll(async () => {
  await admin.query("delete from public.jobs_dead_letter where queue = $1", [QUEUE]);
  await admin.query("delete from public.organizations where id in ($1, $2)", [orgA, orgB]);
  await admin.query("select pgmq.drop_queue($1)", [QUEUE]);
  await worker.end();
  await admin.end();
});

describe("the runner", () => {
  it("runs a job, reports progress and archives the message", async () => {
    const id = await enqueue(orgA);
    await runUntil([testPing], finished(id));

    const row = await job(id);
    expect(row.status).toBe("succeeded");
    expect(row.progress).toBe(100);
    expect(row.attempts).toBe(1);
    expect(row.result).toMatchObject({
      worker_id: "test-worker",
      organization: [expect.stringMatching(/^Worker Test A/)],
    });
    const archived = await admin.query(`select 1 from pgmq.a_${QUEUE} where msg_id = $1`, [
      row.msg_id,
    ]);
    expect(archived.rowCount).toBe(1);
  });

  it("retries a failing job, then dead-letters it and alerts", async () => {
    const id = await enqueue(orgA, { fail: true });
    await runUntil([testPing], finished(id));

    const row = await job(id);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(2);
    // Members see a message written for them, never the internal error.
    expect(row.error).toBe(DEAD_LETTER_USER_MESSAGE);
    const { rows } = await admin.query("select * from public.jobs_dead_letter where job_id = $1", [
      id,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organization_id: orgA,
      attempts: 2,
      error: "Error: Ping was asked to fail",
    });
    const queued = await admin.query(`select 1 from pgmq.q_${QUEUE} where msg_id = $1`, [
      row.msg_id,
    ]);
    expect(queued.rowCount).toBe(0);
  });

  it("dead-letters a malformed message that names no job", async () => {
    const { rows } = await admin.query<{ id: string }>(
      "select pgmq.send($1, '\"garbage\"'::jsonb) as id",
      [QUEUE],
    );
    const msgId = rows[0]!.id;
    const deadLettered = async () =>
      ((
        await admin.query(
          "select 1 from public.jobs_dead_letter where msg_id = $1 and queue = $2",
          [msgId, QUEUE],
        )
      ).rowCount ?? 0) > 0;
    await runUntil([testPing], deadLettered);

    const letter = await admin.query(
      "select * from public.jobs_dead_letter where msg_id = $1 and queue = $2",
      [msgId, QUEUE],
    );
    expect(letter.rows[0]).toMatchObject({
      job_id: null,
      organization_id: null,
      message: "garbage",
    });
  });

  it("fails a job for the user without retrying when the handler says so", async () => {
    const failing = defineHandler({
      queue: QUEUE,
      payload: z.object({}),
      async run() {
        throw new JobFailedError("The file has no items we could read.");
      },
    }) as JobHandler<unknown>;
    const id = await enqueue(orgA);
    await runUntil([failing], finished(id));

    const row = await job(id);
    expect(row).toMatchObject({
      status: "failed",
      attempts: 1,
      error: "The file has no items we could read.",
    });
    const letters = await admin.query("select 1 from public.jobs_dead_letter where job_id = $1", [
      id,
    ]);
    expect(letters.rowCount).toBe(0);
  });

  it("dead-letters a message delivered too often (a worker crashing on it)", async () => {
    const id = await enqueue(orgA);
    // Three earlier deliveries that never finished.
    for (let i = 0; i < 3; i++) await admin.query("select * from pgmq.read($1, 0, 1)", [QUEUE]);
    await runUntil([testPing], finished(id));

    const { rows } = await admin.query(
      "select error from public.jobs_dead_letter where job_id = $1",
      [id],
    );
    expect(rows[0]?.error).toBe("Error: Too many deliveries");
  });
});

describe("org scoping (T0.6.6)", () => {
  it("lets a handler see and change only its own organization", async () => {
    // A job of org B that a buggy org-A handler might try to touch.
    const { rows } = await admin.query<{ id: string }>(
      "insert into public.ai_jobs (organization_id, queue) values ($1, 'other') returning id",
      [orgB],
    );
    const otherJob = rows[0]!.id;

    const nosy = defineHandler({
      queue: QUEUE,
      payload: z.object({}),
      async run({ db }) {
        return db(async (client) => {
          const orgs = await client.query<{ name: string }>(
            "select name from public.organizations",
          );
          const seen = await client.query("select 1 from public.ai_jobs where id = $1", [otherJob]);
          const changed = await client.query(
            "update public.ai_jobs set status = 'failed' where id = $1",
            [otherJob],
          );
          return {
            result: {
              organizations: orgs.rows.map((row) => row.name),
              sawOther: seen.rowCount,
              changedOther: changed.rowCount,
            },
          };
        });
      },
    }) as JobHandler<unknown>;
    const id = await enqueue(orgA);
    await runUntil([nosy], finished(id));

    expect((await job(id)).result).toEqual({
      organizations: [expect.stringMatching(/^Worker Test A/)],
      sawOther: 0,
      changedOther: 0,
    });
    expect((await job(otherJob)).status).toBe("queued");
  });

  it("refuses to scope to something that is not an organization id", async () => {
    const { withOrg } = await import("../src/db.js");
    await expect(withOrg(worker, "'; drop table x; --", async () => null)).rejects.toThrow(
      /Not an organization id/,
    );
  });
});
