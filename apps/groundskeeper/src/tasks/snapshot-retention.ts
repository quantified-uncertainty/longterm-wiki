import type { Config } from "../config.js";
import { logger as rootLogger } from "../logger.js";

const logger = rootLogger.child({ task: "snapshot-retention" });

interface CleanupResult {
  deleted: number;
  keep: number;
}

interface CleanupError {
  status?: number;
  body?: string;
  error?: string;
}

function formatCleanupError(err?: CleanupError): string {
  if (!err) return "unknown";
  if (err.status) return `HTTP ${err.status}`;
  if (err.error) return err.error;
  if (err.body) return err.body.slice(0, 50);
  return "unknown";
}

function getWikiServerApiKey(): string | undefined {
  const prefix = process.env["WIKI_SERVER_ENV"] === "prod" ? "PROD_" : "";
  return process.env[`${prefix}LONGTERMWIKI_SERVER_API_KEY`];
}

/**
 * Call the wiki-server cleanup endpoint for a snapshot table.
 * Returns the number of rows deleted, or null on failure.
 */
async function callCleanupEndpoint(
  config: Config,
  path: string,
  keep: number,
): Promise<{ result: CleanupResult | null; error?: CleanupError }> {
  const url = `${config.wikiServerUrl}${path}?keep=${keep}`;
  const apiKey = getWikiServerApiKey();

  if (!apiKey) {
    logger.warn("LONGTERMWIKI_SERVER_API_KEY is not set — skipping cleanup.");
    return { result: null, error: { error: "no API key" } };
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
      return { result: null, error: { status: res.status, body: text.slice(0, 100) } };
    }

    return { result: (await res.json()) as CleanupResult };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(
      { error: errorMsg, path },
      "Cleanup request failed",
    );
    return { result: null, error: { error: errorMsg } };
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
  const apiKey = getWikiServerApiKey();
  if (!apiKey) {
    logger.warn("LONGTERMWIKI_SERVER_API_KEY is not set — skipping cleanup.");
    return { success: true, summary: "Skipped: no API key configured (see #1770)" };
  }

  const results: string[] = [];
  let anyFailed = false;

  // 1. Hallucination risk snapshots
  const hr = await callCleanupEndpoint(
    config,
    "/api/hallucination-risk/cleanup",
    keep,
  );
  if (hr.result) {
    results.push(`hallucination_risk: deleted ${hr.result.deleted}`);
    logger.info({ table: "hallucination_risk_snapshots", deleted: hr.result.deleted, keep }, "Cleanup complete");
  } else {
    const detail = formatCleanupError(hr.error);
    results.push(`hallucination_risk: FAILED (${detail})`);
    anyFailed = true;
  }

  // 2. Citation accuracy snapshots
  const ca = await callCleanupEndpoint(
    config,
    "/api/citations/accuracy-snapshots/cleanup",
    keep,
  );
  if (ca.result) {
    results.push(`citation_accuracy: deleted ${ca.result.deleted}`);
    logger.info({ table: "citation_accuracy_snapshots", deleted: ca.result.deleted, keep }, "Cleanup complete");
  } else {
    const detail = formatCleanupError(ca.error);
    results.push(`citation_accuracy: FAILED (${detail})`);
    anyFailed = true;
  }

  const summary = `Retention (keep=${keep}): ${results.join(", ")}`;

  if (anyFailed) {
    return { success: false, summary };
  }

  return { success: true, summary };
}
