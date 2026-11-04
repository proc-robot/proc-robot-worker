import type { z } from "zod";
import type { DbClient } from "./db.js";
import type { Logger } from "./log.js";

export type JobRef = {
  id: string;
  queue: string;
  organizationId: string;
  /** 1 on the first delivery. */
  attempt: number;
};

/** What a handler gets. Everything tenant-related goes through `db`. */
export type JobContext<Payload> = {
  job: JobRef;
  payload: Payload;
  /** 0–100 plus a short line for the UI (sent over Realtime). */
  progress(percent: number, message?: string): Promise<void>;
  /** A transaction scoped to the job's organization (see withOrg in db.ts). */
  db<T>(fn: (client: DbClient) => Promise<T>): Promise<T>;
  /** Aborted when the worker shuts down; long steps should stop early. */
  signal: AbortSignal;
  /** This worker process (WORKER_ID), for results and logs. */
  workerId: string;
  log: Logger;
};

export type JobOutcome = {
  /** Stored in ai_jobs.result: what the UI shows when the job is done. */
  result?: Record<string, unknown>;
  creditsConsumed?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
};

export type JobHandler<Payload> = {
  queue: string;
  /** Validates the message payload; a mismatch is a producer bug → dead letter. */
  payload: z.ZodType<Payload>;
  run(context: JobContext<Payload>): Promise<JobOutcome | void>;
};

export function defineHandler<Payload>(handler: JobHandler<Payload>): JobHandler<Payload> {
  return handler;
}

/**
 * A failure the user should see and that retrying cannot fix (an unreadable
 * file, a document with no items). The job is marked failed with this
 * message and not retried. Any other error is retried, then dead-lettered.
 */
export class JobFailedError extends Error {
  override readonly name = "JobFailedError";
}
