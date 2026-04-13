import type { Config } from "../config.js";
import { logger as rootLogger } from "../logger.js";
import { sendDiscordNotification } from "../notify.js";

const logger = rootLogger.child({ task: "snapshot-retention" });

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Module-level state so the missing-API-key Discord alert fires at most once
// per day even if the task is configured to run more often than daily. Resets
// on process restart, which is desirable — a pod restart warrants a fresh
// warning so operators know the key is still missing. Assumes the groundskeeper
// runs as a singleton deployment (replicas=1); multi-replica scaling would
// produce up to N alerts per day, one per replica.
let lastMissingKeyWarnAt = 0;

/** Test-only: reset the missing-API-key rate-limit counter. */
export function __resetMissingKeyRateLimitForTest(): void {
  lastMissingKeyWarnAt = 0;
}

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

  // Missing API key is treated as a non-crashing failure. Historical context
  // (#1770, QUA-352): this handler originally returned {success: true} on a
  // missing key to avoid tripping the groundskeeper circuit breaker on every
  // run. That hid the failure indefinitely and let hallucination_risk_snapshots
  // grow unbounded to 3.3M rows. The fix: still return without calling the
  // cleanup endpoints (so the circuit breaker is not hammered by a config
  // error the task cannot resolve), but mark success=false so monitoring
  // catches it AND emit a Discord alert (rate-limited to once per day) so the
  // on-call sees it.
  const apiKey = getWikiServerApiKey();
  if (!apiKey) {
    const summary =
      "Skipped: LONGTERMWIKI_SERVER_API_KEY is not set. Snapshot retention " +
      "cannot run — hallucination_risk_snapshots and citation_accuracy_snapshots " +
      "will grow unbounded until this is fixed.";
    logger.error({ reason: "missing_api_key" }, summary);

    const now = Date.now();
    if (now - lastMissingKeyWarnAt >= ONE_DAY_MS) {
      lastMissingKeyWarnAt = now;
      void sendDiscordNotification(
        config,
        "⚠️ **Groundskeeper: snapshot retention disabled** — " +
          "`LONGTERMWIKI_SERVER_API_KEY` is not set in the groundskeeper pod. " +
          "`hallucination_risk_snapshots` and `citation_accuracy_snapshots` will " +
          "grow unbounded until this is fixed. Check that the secret is synced " +
          "from 1Password into the groundskeeper deployment. See QUA-352.",
      );
    }
    return { success: false, summary };
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
