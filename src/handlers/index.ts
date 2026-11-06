import type { Services } from "../services.js";
import type { JobHandler } from "../types.js";
import { extractDocument } from "./extract.js";
import { inspectDocument } from "./inspect-document.js";
import { ping } from "./ping.js";

/**
 * Every queue the worker serves. A new job type = a handler file here plus
 * its queue (pgmq.create in a migration) and the RPC that enqueues it.
 * Queues from PLAN.md still waiting for their handlers: import_price_list,
 * price_discovery, render_document, analyze_template.
 */
export function createHandlers(services: Services): JobHandler<unknown>[] {
  return [ping, inspectDocument(services), extractDocument(services)] as JobHandler<unknown>[];
}

export function selectHandlers(
  handlers: JobHandler<unknown>[],
  queues: string[] | undefined,
): JobHandler<unknown>[] {
  if (!queues) return handlers;
  const unknown = queues.filter((queue) => !handlers.some((handler) => handler.queue === queue));
  if (unknown.length > 0) throw new Error(`No handler for queue(s): ${unknown.join(", ")}`);
  return handlers.filter((handler) => queues.includes(handler.queue));
}
