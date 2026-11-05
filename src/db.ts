import pg from "pg";
import type { Logger } from "./log.js";

export type Pool = pg.Pool;
export type DbClient = pg.PoolClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createPool(connectionString: string, max: number, log: Logger): Pool {
  const pool = new pg.Pool({
    connectionString,
    max,
    application_name: "proc-robot-worker",
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // An idle client losing its connection must not crash the process.
  pool.on("error", (error) => log.warn("idle database client failed", { error }));
  return pool;
}

/** Runs `fn` in one transaction on one client (never through pool.query). */
export async function inTransaction<T>(
  pool: Pool,
  fn: (client: DbClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The org scoping guard (TASKS.md T0.6.6). Runs `fn` in a transaction that
 * names the organization the job belongs to; the procrobot_worker policies
 * (supabase/migrations/*_worker.sql) then show and change only that
 * organization's rows. Every tenant query of a job goes through here.
 *
 * `set_config(…, true)` is transaction-local, so the setting cannot leak to
 * the next user of a pooled connection (Supavisor transaction mode included).
 */
export async function withOrg<T>(
  pool: Pool,
  organizationId: string,
  fn: (client: DbClient) => Promise<T>,
): Promise<T> {
  if (!UUID.test(organizationId)) throw new Error(`Not an organization id: ${organizationId}`);
  return inTransaction(pool, async (client) => {
    await client.query("select set_config('app.worker_org_id', $1, true)", [organizationId]);
    return fn(client);
  });
}
