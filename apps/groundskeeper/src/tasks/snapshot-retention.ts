import type { Config } from "../config.js";
import { logger as rootLogger } from "../logger.js";

const logger = rootLogger.child({ task: "snapshot-retention" });

interface CleanupResult {
  deleted: number;
  keep: number;
}

/**
 * Call the wiki-server cleanup endpoint for a snapshot table.
 * Returns the number of rows deleted, or null on failure.
 *
 * The cleanup endpoints (/api/hallucination-risk/cleanup and
 * /api/citations/accuracy-snapshots/cleanup) require `content` scope.
 * Use LONGTERMWIKI_CONTENT_KEY for the content-scoped key, or fall back
 * to LONGTERMWIKI_SERVER_API_KEY (legacy superkey that grants all scopes).
 *
 * Do NOT use WIKI_SERVER_API_KEY here — that key has `project` scope only
 * and will be rejected with 403 on content-scope DELETE endpoints.
 */
async function callCleanupEndpoint(
  config: Config,
  path: string,
  keep: number,
): Promise<CleanupResult | null> {
  const url = `${config.wikiServerUrl}${path}?keep=${keep}`;
  // Use content-scoped key for cleanup endpoints (require `content` scope).
  // Fall back to legacy superkey which grants all scopes.
  const apiKey =
    process.env["LONGTERMWIKI_CONTENT_KEY"] ??
    process.env["LONGTERMWIKI_SERVER_API_KEY"];

  if (!apiKey) {
    logger.warn(
      "Neither LONGTERMWIKI_CONTENT_KEY nor LONGTERMWIKI_SERVER_API_KEY is set — skipping cleanup. " +
        "Set LONGTERMWIKI_CONTENT_KEY (content-scoped) or LONGTERMWIKI_SERVER_API_KEY (legacy superkey) " +
        "in the groundskeeper environment.",
    );
    return null;
  }

  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(120_000), // 2 minute timeout for large deletes
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.error({ status: res.status, body: text.slice(0, 200), path }, "Cleanup endpoint failed");
      return null;
    }

    return (await res.json()) as CleanupResult;
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.message : String(err), path },
      "Cleanup request failed",
    );
    return null;
  }
}

/**
 * Snapshot retention task: prunes old hallucination_risk_snapshots and
 * citation_accuracy_snapshots, keeping the latest N snapshots per page.
 *
 * Runs daily. Calls the existing DELETE /cleanup endpoints on the wiki-server.
 */
export async function snapshotRetention(
  config: Config,
): Promise<{ success: boolean; summary?: string }> {
  const keep = config.tasks.snapshotRetention.keep;

  // Check for API key early — missing config is a graceful skip, not a failure.
  // Treating it as failure trips the circuit breaker on every run (see #1770).
  const apiKey =
    process.env["LONGTERMWIKI_CONTENT_KEY"] ??
    process.env["LONGTERMWIKI_SERVER_API_KEY"];
  if (!apiKey) {
    logger.warn(
      "Neither LONGTERMWIKI_CONTENT_KEY nor LONGTERMWIKI_SERVER_API_KEY is set — skipping cleanup. " +
        "Set LONGTERMWIKI_CONTENT_KEY (content-scoped) or LONGTERMWIKI_SERVER_API_KEY (legacy superkey) " +
        "in the groundskeeper environment.",
    );
    return { success: true, summary: "Skipped: no API key configured (see #1770)" };
  }

  const results: string[] = [];
  let anyFailed = false;

  // 1. Hallucination risk snapshots
  const hrResult = await callCleanupEndpoint(
    config,
    "/api/hallucination-risk/cleanup",
    keep,
  );
  if (hrResult) {
    results.push(`hallucination_risk: deleted ${hrResult.deleted}`);
    logger.info({ table: "hallucination_risk_snapshots", deleted: hrResult.deleted, keep }, "Cleanup complete");
  } else {
    results.push("hallucination_risk: FAILED");
    anyFailed = true;
  }

  // 2. Citation accuracy snapshots
  const caResult = await callCleanupEndpoint(
    config,
    "/api/citations/accuracy-snapshots/cleanup",
    keep,
  );
  if (caResult) {
    results.push(`citation_accuracy: deleted ${caResult.deleted}`);
    logger.info({ table: "citation_accuracy_snapshots", deleted: caResult.deleted, keep }, "Cleanup complete");
  } else {
    results.push("citation_accuracy: FAILED");
    anyFailed = true;
  }

  const summary = `Retention (keep=${keep}): ${results.join(", ")}`;

  if (anyFailed) {
    return { success: false, summary };
  }

  return { success: true, summary };
}
