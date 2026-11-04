import { alert } from "./alert.js";
import { inTransaction, withOrg, type DbClient, type Pool } from "./db.js";
import { jobs } from "./jobs.js";
import type { Logger } from "./log.js";
import type { Queue, QueueMessage } from "./queue.js";
import type { JobRef } from "./types.js";

export const DEAD_LETTER_USER_MESSAGE =
  "This job could not be completed. Proc-Robot has been notified and will look into it.";

const describe = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/**
 * Gives up on a message (TASKS.md T0.6.4): keeps it in jobs_dead_letter for
 * the Super Admin, marks the job failed for the org, removes it from the
 * queue and raises an alert. `job` is null for a message too malformed to
 * name its job and organization.
 */
export async function deadLetter(params: {
  pool: Pool;
  queue: Queue;
  message: QueueMessage;
  job: JobRef | null;
  error: unknown;
  log: Logger;
  alertWebhookUrl?: string;
}): Promise<void> {
  const { pool, queue, message, job, error, log } = params;
  const record = (client: DbClient) =>
    client.query(
      `insert into public.jobs_dead_letter (queue, msg_id, job_id, organization_id, message, error, attempts)
       values ($1, $2::bigint, $3, $4, $5::jsonb, $6, $7)`,
      [
        queue.name,
        message.msgId,
        job?.id ?? null,
        job?.organizationId ?? null,
        JSON.stringify(message.message ?? null),
        describe(error),
        message.readCount,
      ],
    );

  if (job) {
    await withOrg(pool, job.organizationId, record);
    await jobs.failed(pool, job, DEAD_LETTER_USER_MESSAGE);
  } else {
    await inTransaction(pool, record);
  }
  await queue.delete(message.msgId);

  await alert(log, params.alertWebhookUrl, "job moved to the dead-letter table", {
    queue: queue.name,
    msg_id: message.msgId,
    job_id: job?.id,
    organization_id: job?.organizationId,
    attempts: message.readCount,
    error,
  });
}
