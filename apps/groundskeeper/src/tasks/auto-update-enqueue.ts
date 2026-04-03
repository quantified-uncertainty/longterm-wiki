import type { Config } from "../config.js";
import { logger as rootLogger } from "../logger.js";
import { apiRequest } from "../wiki-server.js";

const logger = rootLogger.child({ task: "auto-update-enqueue" });

/**
 * Enqueue an auto-update run via the wiki-server jobs API.
 *
 * Creates a job of type "auto-update" with budget and maxPages from config.
 * The job worker picks it up and runs `crux w auto-update run`.
 */
export async function autoUpdateEnqueue(config: Config): Promise<{ success: boolean; summary?: string }> {
  const { budget, maxPages } = config.tasks.autoUpdateEnqueue;

  logger.info({ budget, maxPages }, "Enqueuing auto-update job");

  try {
    const result = await apiRequest<{ id: number }>(config, "POST", "/api/jobs", {
      type: "auto-update",
      payload: { budget, maxPages },
    });

    if (result.ok && result.data) {
      logger.info({ jobId: result.data.id }, "Auto-update job enqueued");
      return { success: true, summary: `Job #${result.data.id} enqueued` };
    }

    logger.warn({ error: result.error }, "Failed to enqueue auto-update job");
    return { success: false, summary: result.error ?? "Unknown error" };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error({ error: msg }, "Auto-update enqueue failed");
    return { success: false, summary: msg };
  }
}
