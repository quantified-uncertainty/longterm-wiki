import type { Config } from "../config.js";
import { logger as rootLogger } from "../logger.js";

const logger = rootLogger.child({ task: "things-search-refresh" });

function getWikiServerApiKey(): string | undefined {
  const prefix = process.env["WIKI_SERVER_ENV"] === "prod" ? "PROD_" : "";
  return process.env[`${prefix}LONGTERMWIKI_SERVER_API_KEY`];
}

// QUA-506: hourly MV refresh via POST /api/things-search/refresh.
export async function thingsSearchRefresh(
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
      logger.error(`${summary} — refresh not attempted.`);
      return { success: false, summary };
    }
    logger.warn(`${summary} — skipping refresh.`);
    return { success: true, summary: `Skipped: ${summary}` };
  }

  const url = `${config.wikiServerUrl}/api/things-search/refresh`;

  try {
    // 120s ceiling: benchmark max 19s + managed-pg noise headroom.
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.error(
        { status: res.status, body: text.slice(0, 200) },
        "Refresh call failed",
      );
      return {
        success: false,
        summary: `HTTP ${res.status}: ${text.slice(0, 100)}`,
      };
    }

    const data = (await res.json()) as {
      success?: boolean;
      durationMs?: number;
      rowCount?: number | null;
      totalBytes?: number | null;
      error?: string;
    };

    if (!data.success) {
      const msg = `refresh endpoint reported failure: ${data.error ?? "no details"}`;
      logger.error({ data }, msg);
      return { success: false, summary: msg };
    }

    const durationMs = data.durationMs ?? 0;
    const rowCount = data.rowCount ?? null;
    const summary = `things_search refreshed in ${durationMs}ms (${rowCount ?? "?"} rows)`;
    logger.info({ durationMs, rowCount }, summary);
    return { success: true, summary };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "things_search refresh request failed");
    return { success: false, summary: msg };
  }
}
