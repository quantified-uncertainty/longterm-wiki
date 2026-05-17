import type { Config } from "../config.js";
import { logger as rootLogger } from "../logger.js";
import { apiRequest } from "../wiki-server.js";

const logger = rootLogger.child({ task: "backfill-sources-enqueue" });

/**
 * Enqueue a backfill-sources run via the wiki-server jobs API.
 *
 * Creates a job of type "backfill-sources" with limit and maxCost from config.
 * The job worker picks it up and runs `crux tb backfill-sources --apply`.
 */
export async function backfillSourcesEnqueue(
  config: Config,
): Promise<{ success: boolean; summary?: string }> {
  const { limit, maxCost } = config.tasks.backfillSourcesEnqueue;

  logger.info({ limit, maxCost }, "Enqueuing backfill-sources job");

  try {
    const result = await apiRequest<{ id: number }>(
      config,
      "POST",
      "/api/jobs",
      {
        type: "backfill-sources",
        payload: { limit, maxCost },
      },
    );

    if (result.ok && result.data) {
      logger.info({ jobId: result.data.id }, "Backfill-sources job enqueued");
      return { success: true, summary: `Job #${result.data.id} enqueued` };
    }

    logger.warn(
      { error: result.error },
      "Failed to enqueue backfill-sources job",
    );
    return { success: false, summary: result.error ?? "Unknown error" };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error({ error: msg }, "Backfill-sources enqueue failed");
    return { success: false, summary: msg };
  }
}
