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
export async function autoUpdateEnqueue(config: Config): Promise<void> {
  const { budget, maxPages } = config.tasks.autoUpdateEnqueue;

  logger.info({ budget, maxPages }, "Enqueuing auto-update job");

  try {
    const result = await apiRequest<{ id: number }>("POST", "/api/jobs", {
      type: "auto-update",
      payload: { budget, maxPages },
    });

    if (result.ok) {
      logger.info({ jobId: result.data.id }, "Auto-update job enqueued");
    } else {
      logger.warn({ status: result.status }, "Failed to enqueue auto-update job");
    }
  } catch (e: unknown) {
    logger.error(
      { error: e instanceof Error ? e.message : String(e) },
      "Auto-update enqueue failed"
    );
  }
}
