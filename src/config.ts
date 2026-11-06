import { hostname } from "node:os";
import { z } from "zod";

const number = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const schema = z.object({
  /** The procrobot_worker role — never the service-role key (PLAN.md → Secrets). */
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "DATABASE_URL must be a postgres:// URL"),
  WORKER_ID: z.string().min(1).default(`${hostname()}-${process.pid}`),
  /** Jobs run at once by this process, across all its queues. */
  WORKER_CONCURRENCY: number(4, 1, 64),
  /** Comma-separated queue names; default: every queue with a handler. */
  WORKER_QUEUES: z
    .string()
    .optional()
    .transform((value) =>
      value
        ?.split(",")
        .map((queue) => queue.trim())
        .filter(Boolean),
    ),
  /** Deliveries before a message goes to jobs_dead_letter. */
  JOB_MAX_ATTEMPTS: number(5, 1, 50),
  /** How long a read message stays invisible; extended while the job runs. */
  JOB_VISIBILITY_TIMEOUT_SECONDS: number(60, 5, 3600),
  /** Retry delay = base × 2^(attempt−1), capped at 10 minutes. */
  JOB_RETRY_BASE_SECONDS: number(30, 0, 600),
  /** Long-poll window of each read. */
  POLL_SECONDS: number(5, 1, 30),
  /** GET /health; falls back to PORT, which Railway sets and health-checks. */
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  ALERT_WEBHOOK_URL: z.url().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /** Supabase Storage, for the files jobs read and write (never the database). */
  SUPABASE_URL: z.url().optional(),
  SUPABASE_SECRET_KEY: z.string().min(20).optional(),
  /** Claude, for document extraction (T1.3). */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  EXTRACTION_MODEL: z.string().min(1).default("claude-haiku-5-5"),
  /** Reads a part again when the first model is unsure or fails. */
  EXTRACTION_REVIEW_MODEL: z.string().min(1).default("claude-opus-5-5"),
  /** Tests and local development only: read spreadsheets by column name, without AI. */
  EXTRACTION_FAKE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  SHUTDOWN_GRACE_SECONDS: number(25, 0, 300),
});

export type Config = z.output<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Empty strings from .env files mean "not set".
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  cleaned.HEALTH_PORT ??= cleaned.PORT;
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(`Invalid worker configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
