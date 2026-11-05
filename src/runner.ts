import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { Config } from "./config.js";
import { deadLetter } from "./dead-letter.js";
import { withOrg, type Pool } from "./db.js";
import { jobs } from "./jobs.js";
import type { Logger } from "./log.js";
import { Queue, type QueueMessage } from "./queue.js";
import { JobFailedError, type JobContext, type JobHandler, type JobRef } from "./types.js";

/** Every message sent by private.enqueue_job(). */
const envelope = z.object({
  job_id: z.uuid(),
  organization_id: z.uuid(),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export type RunnerOptions = Pick<
  Config,
  | "WORKER_ID"
  | "WORKER_CONCURRENCY"
  | "JOB_MAX_ATTEMPTS"
  | "JOB_VISIBILITY_TIMEOUT_SECONDS"
  | "JOB_RETRY_BASE_SECONDS"
  | "POLL_SECONDS"
  | "ALERT_WEBHOOK_URL"
>;

export type RunnerStatus = {
  workerId: string;
  queues: string[];
  running: number;
  startedAt: Date;
  lastPollAt: Date | null;
  stopping: boolean;
};

/**
 * The queue loop (TASKS.md T0.6.3). One long-polling loop per queue; at most
 * WORKER_CONCURRENCY jobs at once across all of them.
 *
 * Per message: validate → mark running → run the handler while extending
 * the message's visibility (heartbeat) → archive on success. A failure is
 * retried with exponential backoff (the message simply becomes visible
 * again); after JOB_MAX_ATTEMPTS deliveries it goes to the dead-letter table.
 * A JobFailedError fails the job for the user at once, without retries.
 */
export class Runner {
  private readonly running = new Set<Promise<void>>();
  /** Aborted when stop() begins: no new reads, back-off sleeps end early. */
  private readonly stopReading = new AbortController();
  /** Aborted when the grace period ends: handlers should stop. */
  private readonly shutdown = new AbortController();
  private readonly startedAt = new Date();
  private reserved = 0;
  private loops: Promise<void>[] = [];
  private lastPollAt: Date | null = null;
  private slotWaiters: (() => void)[] = [];

  constructor(
    private readonly pool: Pool,
    private readonly handlers: JobHandler<unknown>[],
    private readonly options: RunnerOptions,
    private readonly log: Logger,
  ) {}

  start(): void {
    this.loops = this.handlers.map((handler) => this.poll(handler));
    this.log.info("worker started", {
      queues: this.handlers.map((handler) => handler.queue),
      concurrency: this.options.WORKER_CONCURRENCY,
    });
  }

  /** Stops reading, waits up to `graceSeconds` for running jobs, then aborts them. */
  async stop(graceSeconds: number): Promise<void> {
    if (this.stopReading.signal.aborted) return;
    this.stopReading.abort();
    this.wakeSlotWaiters();
    await Promise.all(this.loops);

    const finished = Promise.allSettled([...this.running]);
    const grace = new AbortController();
    const timedOut = await Promise.race([
      finished.then(() => false),
      sleep(graceSeconds * 1000, true, { signal: grace.signal }).catch(() => false),
    ]);
    grace.abort();
    if (timedOut) {
      // Their messages become visible again after the visibility timeout.
      this.log.warn("shutting down with jobs still running", { running: this.running.size });
    }
    this.shutdown.abort();
    await finished;
    this.log.info("worker stopped");
  }

  status(): RunnerStatus {
    return {
      workerId: this.options.WORKER_ID,
      queues: this.handlers.map((handler) => handler.queue),
      running: this.running.size,
      startedAt: this.startedAt,
      lastPollAt: this.lastPollAt,
      stopping: this.stopping,
    };
  }

  private get stopping() {
    return this.stopReading.signal.aborted;
  }

  private freeSlots() {
    return this.options.WORKER_CONCURRENCY - this.running.size - this.reserved;
  }

  private waitForSlot(): Promise<void> {
    return new Promise((resolve) => this.slotWaiters.push(resolve));
  }

  private wakeSlotWaiters() {
    const waiters = this.slotWaiters;
    this.slotWaiters = [];
    waiters.forEach((wake) => wake());
  }

  private async poll(handler: JobHandler<unknown>): Promise<void> {
    const queue = new Queue(this.pool, handler.queue);
    while (!this.stopping) {
      const free = this.freeSlots();
      if (free <= 0) {
        await this.waitForSlot();
        continue;
      }

      this.reserved += free;
      let messages: QueueMessage[] = [];
      try {
        messages = await queue.read(
          free,
          this.options.JOB_VISIBILITY_TIMEOUT_SECONDS,
          this.options.POLL_SECONDS,
        );
        this.lastPollAt = new Date();
      } catch (error) {
        this.log.error("reading the queue failed", { queue: queue.name, error });
        await sleep(5000, undefined, { signal: this.stopReading.signal }).catch(() => {});
      } finally {
        this.reserved -= free;
      }

      for (const message of messages) {
        const task = this.process(handler, queue, message).finally(() => {
          this.running.delete(task);
          this.wakeSlotWaiters();
        });
        this.running.add(task);
      }
    }
  }

  private async process(handler: JobHandler<unknown>, queue: Queue, message: QueueMessage) {
    const log = this.log.child({
      queue: queue.name,
      msg_id: message.msgId,
      attempt: message.readCount,
    });
    const giveUp = (job: JobRef | null, error: unknown) =>
      deadLetter({
        pool: this.pool,
        queue,
        message,
        job,
        error,
        log,
        alertWebhookUrl: this.options.ALERT_WEBHOOK_URL,
      });

    try {
      const parsed = envelope.safeParse(message.message);
      if (!parsed.success) return await giveUp(null, new Error("Malformed job message"));

      const job: JobRef = {
        id: parsed.data.job_id,
        queue: queue.name,
        organizationId: parsed.data.organization_id,
        attempt: message.readCount,
      };
      const jobLog = log.child({ job_id: job.id, organization_id: job.organizationId });

      // Delivered too often: a worker died mid-job repeatedly.
      if (message.readCount > this.options.JOB_MAX_ATTEMPTS) {
        return await giveUp(job, new Error("Too many deliveries"));
      }
      const payload = handler.payload.safeParse(parsed.data.payload);
      if (!payload.success)
        return await giveUp(job, new Error(`Invalid payload: ${payload.error.message}`));

      await this.run(handler, queue, message, job, payload.data, jobLog, giveUp);
    } catch (error) {
      // Bookkeeping itself failed (e.g. the database is down). The message
      // becomes visible again after the visibility timeout.
      log.error("processing a message failed", { error });
    }
  }

  private async run(
    handler: JobHandler<unknown>,
    queue: Queue,
    message: QueueMessage,
    job: JobRef,
    payload: unknown,
    log: Logger,
    giveUp: (job: JobRef | null, error: unknown) => Promise<void>,
  ) {
    const startedAt = Date.now();
    await jobs.running(this.pool, job);
    log.info("job started");

    // Keep the message invisible and the job's heartbeat fresh while it runs.
    const vt = this.options.JOB_VISIBILITY_TIMEOUT_SECONDS;
    const heartbeat = setInterval(
      () => {
        Promise.all([queue.setVisibility(message.msgId, vt), jobs.heartbeat(this.pool, job)]).catch(
          (error) => log.warn("heartbeat failed", { error }),
        );
      },
      Math.max(1000, (vt * 1000) / 3),
    );

    const context: JobContext<unknown> = {
      job,
      payload,
      progress: async (percent, text) => {
        await jobs.progress(this.pool, job, percent, text);
      },
      db: (fn) => withOrg(this.pool, job.organizationId, fn),
      signal: this.shutdown.signal,
      workerId: this.options.WORKER_ID,
      log,
    };

    try {
      const outcome = (await handler.run(context)) ?? {};
      await jobs.succeeded(this.pool, job, outcome);
      await queue.archive(message.msgId);
      log.info("job succeeded", { duration_ms: Date.now() - startedAt });
    } catch (error) {
      if (error instanceof JobFailedError) {
        await jobs.failed(this.pool, job, error.message);
        await queue.archive(message.msgId);
        log.info("job failed for the user", { reason: error.message });
      } else if (job.attempt >= this.options.JOB_MAX_ATTEMPTS) {
        await giveUp(job, error);
      } else {
        const delay = Math.min(600, this.options.JOB_RETRY_BASE_SECONDS * 2 ** (job.attempt - 1));
        await jobs.retrying(this.pool, job, this.options.JOB_MAX_ATTEMPTS);
        await queue.setVisibility(message.msgId, delay);
        log.warn("job failed; will retry", { error, retry_in_s: delay });
      }
    } finally {
      clearInterval(heartbeat);
    }
  }
}
