import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { selectHandlers } from "./handlers/index.js";
import { startHealthServer } from "./health.js";
import { startHeartbeat } from "./heartbeat.js";
import { createLogger } from "./log.js";
import { Runner } from "./runner.js";

// Local development reads worker/.env; Railway sets real environment variables.
if (existsSync(".env")) process.loadEnvFile(".env");

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL, { worker_id: config.WORKER_ID });
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  version: string;
};

const handlers = selectHandlers(config.WORKER_QUEUES);
// One connection per running job, one per polling loop, plus room for heartbeats.
const pool = createPool(config.DATABASE_URL, config.WORKER_CONCURRENCY + handlers.length + 2, log);

const runner = new Runner(pool, handlers, config, log);
runner.start();
const stopHeartbeat = startHeartbeat(pool, () => runner.status(), version, log);
const health = config.HEALTH_PORT
  ? startHealthServer(config.HEALTH_PORT, () => runner.status(), config.POLL_SECONDS)
  : null;

// Railway sends SIGTERM on deploys and restarts.
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("shutting down", { signal });
  health?.close();
  await runner.stop(config.SHUTDOWN_GRACE_SECONDS);
  await stopHeartbeat();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (error) => log.error("unhandled rejection", { error }));
