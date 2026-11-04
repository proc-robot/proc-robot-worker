import { hostname } from "node:os";
import type { Pool } from "./db.js";
import type { Logger } from "./log.js";
import type { RunnerStatus } from "./runner.js";

const INTERVAL_MS = 15_000;

/**
 * Keeps this process's row in public.worker_heartbeats fresh (T0.6.5), so
 * the Super Admin's jobs monitor sees which workers are alive and busy.
 * Returns a function that stops the beat and removes the row.
 */
export function startHeartbeat(
  pool: Pool,
  status: () => RunnerStatus,
  version: string,
  log: Logger,
) {
  const beat = async () => {
    const current = status();
    await pool.query(
      `insert into public.worker_heartbeats (worker_id, hostname, version, started_at, beat_at, running_jobs, queues)
       values ($1, $2, $3, $4, now(), $5, $6)
       on conflict (worker_id) do update
         set beat_at = now(), running_jobs = excluded.running_jobs, queues = excluded.queues`,
      [current.workerId, hostname(), version, current.startedAt, current.running, current.queues],
    );
  };
  const run = () => beat().catch((error) => log.warn("worker heartbeat failed", { error }));

  void run();
  const timer = setInterval(run, INTERVAL_MS);

  return async () => {
    clearInterval(timer);
    await pool
      .query("delete from public.worker_heartbeats where worker_id = $1", [status().workerId])
      .catch((error) => log.warn("removing the worker heartbeat failed", { error }));
  };
}
