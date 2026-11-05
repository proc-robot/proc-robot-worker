import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { defineHandler } from "../types.js";

/**
 * The worker check (TASKS.md T0.6.8): queued by public.ping_worker() from
 * the dashboard, it proves the whole path — RPC → queue → worker → ai_jobs →
 * Realtime → UI. It reads the organization's name through the scoped
 * connection, which also shows the org scoping at work.
 *
 * `fail` exists for the tests (a poison message); the RPC never sets it.
 */
export const ping = defineHandler({
  queue: "ping",
  payload: z.object({
    requested_at: z.string().optional(),
    fail: z.boolean().optional(),
    delay_ms: z.number().int().min(0).max(10_000).optional(),
  }),
  async run({ job, payload, progress, db, signal, workerId }) {
    await progress(50, "The worker picked up the check.");
    if (payload.fail) throw new Error("Ping was asked to fail");

    await sleep(payload.delay_ms ?? 300, undefined, { signal });
    const { rows } = await db((client) =>
      client.query<{ name: string }>("select name from public.organizations"),
    );

    return {
      result: {
        worker_id: workerId,
        organization: rows.map((row) => row.name),
        attempt: job.attempt,
        completed_at: new Date().toISOString(),
      },
    };
  },
});
