import type { Logger } from "./log.js";

/**
 * Something an operator must look at (a dead letter). Always logged with
 * `alert: true` (Better Stack alerts on it, T0.7.5); also posted to a
 * Slack-compatible webhook when ALERT_WEBHOOK_URL is set. Never throws.
 */
export async function alert(
  log: Logger,
  webhookUrl: string | undefined,
  message: string,
  fields: Record<string, unknown> = {},
): Promise<void> {
  log.error(message, { ...fields, alert: true });
  if (!webhookUrl) return;

  const details = Object.entries(fields)
    .filter(([key]) => key !== "error")
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(" · ");
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `[proc-robot-worker] ${message}${details ? `\n${details}` : ""}`,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    log.warn("alert webhook failed", { error });
  }
}
