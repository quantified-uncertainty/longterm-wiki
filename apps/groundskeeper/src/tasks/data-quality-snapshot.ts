import type { Config } from "../config.js";
import { logger as rootLogger } from "../logger.js";

const logger = rootLogger.child({ task: "data-quality-snapshot" });

function getWikiServerApiKey(): string | undefined {
  const prefix = process.env["WIKI_SERVER_ENV"] === "prod" ? "PROD_" : "";
  return process.env[`${prefix}LONGTERMWIKI_SERVER_API_KEY`];
}

/**
 * Data quality snapshot task: captures current data quality metrics
 * (verdict counts, record coverage, entity stats) into the
 * data_quality_snapshots table.
 *
 * Runs daily. Calls POST /api/data-quality on the wiki-server,
 * which aggregates metrics via SQL queries.
 */
export async function dataQualitySnapshot(
  config: Config,
): Promise<{ success: boolean; summary?: string }> {
  const apiKey = getWikiServerApiKey();
  if (!apiKey) {
    logger.warn("LONGTERMWIKI_SERVER_API_KEY is not set — skipping snapshot.");
    return { success: true, summary: "Skipped: no API key configured" };
  }

  const url = `${config.wikiServerUrl}/api/data-quality`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.error({ status: res.status, body: text.slice(0, 200) }, "Snapshot capture failed");
      return { success: false, summary: `HTTP ${res.status}: ${text.slice(0, 100)}` };
    }

    const data = (await res.json()) as {
      id: number;
      verdicts_total?: number;
      verdicts_contradicted?: number;
    };

    const summary = `Snapshot #${data.id} captured (verdicts: ${data.verdicts_total ?? "?"})`;
    logger.info({ snapshotId: data.id }, summary);
    return { success: true, summary };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "Snapshot request failed");
    return { success: false, summary: msg };
  }
}
