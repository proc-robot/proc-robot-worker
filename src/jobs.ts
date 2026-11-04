import { withOrg, type Pool } from "./db.js";
import type { JobOutcome, JobRef } from "./types.js";

/**
 * Status changes on public.ai_jobs, which the UI watches over Realtime.
 * All go through withOrg, so the worker can only touch the job's own org.
 *
 * `error` is shown to the org's members, so it only ever holds a message
 * written for them — never an internal error (those go to the logs and to
 * jobs_dead_letter, which only Super Admins read).
 */
async function update(pool: Pool, job: JobRef, sql: string, params: unknown[] = []) {
  return withOrg(pool, job.organizationId, (client) =>
    client.query(`update public.ai_jobs set ${sql} where id = $1`, [job.id, ...params]),
  );
}

export const jobs = {
  running: (pool: Pool, job: JobRef) =>
    update(
      pool,
      job,
      `status = 'running', attempts = $2, error = null, progress_message = null,
       started_at = coalesce(started_at, now()), heartbeat_at = now()`,
      [job.attempt],
    ),

  heartbeat: (pool: Pool, job: JobRef) => update(pool, job, "heartbeat_at = now()"),

  progress: (pool: Pool, job: JobRef, percent: number, message?: string) =>
    update(pool, job, "progress = $2, progress_message = $3, heartbeat_at = now()", [
      Math.max(0, Math.min(100, Math.round(percent))),
      message ?? null,
    ]),

  succeeded: (pool: Pool, job: JobRef, outcome: JobOutcome) =>
    update(
      pool,
      job,
      `status = 'succeeded', progress = 100, progress_message = null, error = null,
       result = $2, credits_consumed = $3, input_tokens = $4, output_tokens = $5, cost_usd = $6,
       finished_at = now()`,
      [
        outcome.result ? JSON.stringify(outcome.result) : null,
        outcome.creditsConsumed ?? null,
        outcome.inputTokens ?? null,
        outcome.outputTokens ?? null,
        outcome.costUsd ?? null,
      ],
    ),

  /** Back to the queue after a temporary failure. */
  retrying: (pool: Pool, job: JobRef, maxAttempts: number) =>
    update(pool, job, "status = 'queued', error = $2, progress_message = null", [
      `A temporary problem interrupted this job. Retrying (attempt ${job.attempt + 1} of ${maxAttempts}).`,
    ]),

  failed: (pool: Pool, job: JobRef, userMessage: string) =>
    update(
      pool,
      job,
      "status = 'failed', error = $2, progress_message = null, finished_at = now()",
      [userMessage],
    ),
};
