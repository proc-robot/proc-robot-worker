import { createServer, type Server } from "node:http";
import type { RunnerStatus } from "./runner.js";

/**
 * GET /health for Railway's health check and uptime monitoring (Phase 4, T4.1.3):
 * 200 while the queue loop keeps polling, 503 when it has stalled or the
 * worker is shutting down. Nothing else is served.
 */
export function startHealthServer(
  port: number,
  status: () => RunnerStatus,
  pollSeconds: number,
): Server {
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }
    const current = status();
    const stalledAfterMs = (pollSeconds * 3 + 10) * 1000;
    const lastActivity = current.lastPollAt ?? current.startedAt;
    const healthy = !current.stopping && Date.now() - lastActivity.getTime() < stalledAfterMs;

    response.writeHead(healthy ? 200 : 503, { "content-type": "application/json" }).end(
      JSON.stringify({
        status: healthy ? "ok" : "unhealthy",
        worker_id: current.workerId,
        queues: current.queues,
        running_jobs: current.running,
        last_poll_at: current.lastPollAt,
      }),
    );
  });
  server.listen(port);
  return server;
}
