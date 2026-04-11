import type { Config } from "../config.js";
import { logger as rootLogger } from "../logger.js";

const logger = rootLogger.child({ task: "tablebase-scan" });

function getWikiServerApiKey(): string | undefined {
  const prefix = process.env["WIKI_SERVER_ENV"] === "prod" ? "PROD_" : "";
  return process.env[`${prefix}LONGTERMWIKI_SERVER_API_KEY`];
}

interface RunScanResponse {
  scanRunId: string;
  inserted: number;
  tables: number;
  recordTypes?: string[];
  avgCompleteness?: number;
  scannedAt?: string;
  message?: string;
}

/**
 * TableBase scan task: runs a server-side coverage scan and persists results.
 *
 * Calls POST /api/scanner-results/run on the wiki-server, which computes
 * per-entity completeness metrics via SQL and inserts them into the
 * tablebase_scanner_results table. Results feed the TableBase Coverage
 * Dashboard (/internal/tablebase-coverage-dashboard).
 *
 * Runs nightly. Timeout is generous (3 minutes) because the scan touches
 * multiple large tables (grants, personnel, investments, etc.).
 */
export async function tablebaseScan(
  config: Config,
): Promise<{ success: boolean; summary?: string }> {
  const apiKey = getWikiServerApiKey();
  if (!apiKey) {
    const isProd = process.env["WIKI_SERVER_ENV"] === "prod";
    const keyName = isProd
      ? "PROD_LONGTERMWIKI_SERVER_API_KEY"
      : "LONGTERMWIKI_SERVER_API_KEY";
    const summary = `Missing ${keyName}`;
    if (isProd) {
      logger.error(`${summary} — scan not attempted.`);
      return { success: false, summary };
    }
    logger.warn(`${summary} — skipping scan.`);
    return { success: true, summary: `Skipped: ${summary}` };
  }

  const url = `${config.wikiServerUrl}/api/scanner-results/run`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(180_000), // 3 minute timeout for multi-table scan
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.error({ status: res.status, body: text.slice(0, 200) }, "Scan failed");
      return { success: false, summary: `HTTP ${res.status}: ${text.slice(0, 100)}` };
    }

    const data = (await res.json()) as RunScanResponse;

    if (typeof data.inserted !== "number") {
      logger.error({ body: data }, "Scan response schema mismatch");
      return { success: false, summary: "Invalid scan response schema" };
    }

    const summary = [
      `Scan ${data.scanRunId.slice(0, 8)}:`,
      `${data.inserted} rows`,
      `${data.tables} tables`,
      data.avgCompleteness != null ? `avg ${data.avgCompleteness}%` : null,
    ]
      .filter(Boolean)
      .join(", ");

    logger.info(
      {
        scanRunId: data.scanRunId,
        inserted: data.inserted,
        tables: data.tables,
        avgCompleteness: data.avgCompleteness,
      },
      summary,
    );

    return { success: true, summary };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "Scan request failed");
    return { success: false, summary: msg };
  }
}
