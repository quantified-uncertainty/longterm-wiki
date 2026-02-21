/**
 * Wiki Server Page Sync
 *
 * Reads pages.json metadata and per-page .txt content files,
 * then bulk-upserts them to the wiki-server's /api/pages/sync endpoint.
 *
 * Includes:
 *   - Pre-sync health check with retries (waits for server to be ready)
 *   - Per-batch retry with exponential backoff (handles transient 5xx errors)
 *   - Fast-fail after N consecutive batch failures (avoids wasting time on dead server)
 *
 * Usage:
 *   pnpm crux wiki-server sync
 *   pnpm crux wiki-server sync --dry-run
 *   pnpm crux wiki-server sync --batch-size=50
 *
 * Environment:
 *   LONGTERMWIKI_SERVER_URL   - Base URL of the wiki server
 *   LONGTERMWIKI_SERVER_API_KEY - Bearer token for authentication
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { parseCliArgs } from "../lib/cli.ts";
import { getServerUrl, getApiKey, buildHeaders } from "../lib/wiki-server-client.ts";

const PROJECT_ROOT = join(import.meta.dirname!, "../..");
const PAGES_JSON_PATH = join(
  PROJECT_ROOT,
  "apps/web/src/data/pages.json"
);
const WIKI_DIR = join(PROJECT_ROOT, "apps/web/public/wiki");

// --- Configuration ---
const HEALTH_CHECK_RETRIES = 5;
const HEALTH_CHECK_DELAY_MS = 10_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const BATCH_RETRY_ATTEMPTS = 3;
const BATCH_RETRY_BASE_DELAY_MS = 2_000;
const BATCH_TIMEOUT_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;

interface PageData {
  id: string;
  numericId?: string;
  title: string;
  description?: string;
  llmSummary?: string;
  category?: string;
  subcategory?: string;
  entityType?: string;
  tags?: string[];
  quality?: number;
  readerImportance?: number;
  hallucinationRisk?: {
    level?: string;
    score?: number;
  };
  wordCount?: number;
  lastUpdated?: string;
  contentFormat?: string;
}

interface SyncPage {
  id: string;
  numericId: string | null;
  title: string;
  description: string | null;
  llmSummary: string | null;
  category: string | null;
  subcategory: string | null;
  entityType: string | null;
  tags: string | null;
  quality: number | null;
  readerImportance: number | null;
  hallucinationRiskLevel: string | null;
  hallucinationRiskScore: number | null;
  contentPlaintext: string | null;
  wordCount: number | null;
  lastUpdated: string | null;
  contentFormat: string | null;
}

/**
 * Wait for the server to become healthy before syncing.
 * Retries up to `maxRetries` times with a fixed delay between attempts.
 * Exported for testing.
 */
export async function waitForHealthy(
  serverUrl: string,
  options: {
    maxRetries?: number;
    delayMs?: number;
    timeoutMs?: number;
    _sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<boolean> {
  const maxRetries = options.maxRetries ?? HEALTH_CHECK_RETRIES;
  const delayMs = options.delayMs ?? HEALTH_CHECK_DELAY_MS;
  const timeoutMs = options.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;
  const sleep = options._sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`${serverUrl}/health`, {
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.ok) {
        const body = await res.json();
        if (body.status === "healthy") {
          console.log(`  Health check passed (attempt ${attempt}/${maxRetries})`);
          return true;
        }
      }
      console.warn(
        `  Health check attempt ${attempt}/${maxRetries}: not healthy (HTTP ${res.status})`
      );
    } catch (err) {
      console.warn(
        `  Health check attempt ${attempt}/${maxRetries}: ${err instanceof Error ? err.message : err}`
      );
    }

    if (attempt < maxRetries) {
      console.log(`  Retrying in ${delayMs / 1000}s...`);
      await sleep(delayMs);
    }
  }

  return false;
}

/**
 * Fetch with retry and exponential backoff.
 * Only retries on 5xx status codes or network errors.
 * Returns the Response on success, or throws on exhausted retries.
 * Exported for testing.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: {
    maxAttempts?: number;
    baseDelayMs?: number;
    timeoutMs?: number;
    _sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? BATCH_RETRY_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? BATCH_RETRY_BASE_DELAY_MS;
  const timeoutMs = options.timeoutMs ?? BATCH_TIMEOUT_MS;
  const sleep = options._sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Strip caller's signal to avoid conflicts with our timeout signal
      const { signal: _callerSignal, ...initWithoutSignal } = init;
      const res = await fetch(url, {
        ...initWithoutSignal,
        signal: AbortSignal.timeout(timeoutMs),
      });

      // Don't retry client errors (4xx) — they won't resolve on their own
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        return res;
      }

      // 5xx — retry
      const body = await res.text().catch(() => "");
      lastError = new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    } catch (err) {
      lastError = err;
    }

    if (attempt < maxAttempts) {
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(
        `    Attempt ${attempt + 1}/${maxAttempts}: retrying in ${delay / 1000}s...`
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

/** @internal — exported for testing */
export async function syncPages(
  serverUrl: string,
  _apiKey: string,
  pages: SyncPage[],
  batchSize: number,
  options: {
    _sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<{ upserted: number; errors: number }> {
  let totalCreated = 0;
  let totalErrors = 0;
  let consecutiveFailures = 0;

  for (let i = 0; i < pages.length; i += batchSize) {
    const batch = pages.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(pages.length / batchSize);

    try {
      const res = await fetchWithRetry(
        `${serverUrl}/api/pages/sync`,
        {
          method: "POST",
          headers: buildHeaders(),
          body: JSON.stringify({ pages: batch }),
        },
        { _sleep: options._sleep }
      );

      if (!res.ok) {
        const body = await res.text();
        console.error(
          `  Batch ${batchNum}/${totalBatches}: HTTP ${res.status} — ${body}`
        );
        // Surface the server's error message if available (JSON body from improved error handler)
        try {
          const parsed = JSON.parse(body);
          if (parsed.message) {
            console.error(`    Server error: ${parsed.message}`);
          }
        } catch {
          // Not JSON — raw body already printed above
        }
        totalErrors += batch.length;
        consecutiveFailures++;
      } else {
        const result = (await res.json()) as { upserted: number };
        totalCreated += result.upserted;
        consecutiveFailures = 0;

        console.log(
          `  Batch ${batchNum}/${totalBatches}: ${result.upserted} upserted`
        );
      }
    } catch (err) {
      console.error(
        `  Batch ${batchNum}/${totalBatches}: Failed after retries — ${err}`
      );
      totalErrors += batch.length;
      consecutiveFailures++;
    }

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      const remaining = pages.length - (i + batchSize);
      if (remaining > 0) {
        console.error(
          `\n  Aborting: ${MAX_CONSECUTIVE_FAILURES} consecutive batch failures. ` +
            `Skipping ${remaining} remaining pages.`
        );
        totalErrors += remaining;
      }
      break;
    }
  }

  return { upserted: totalCreated, errors: totalErrors };
}

function loadContent(numericId: string | undefined): string | null {
  if (!numericId) return null;

  const txtPath = join(WIKI_DIR, `${numericId}.txt`);
  if (!existsSync(txtPath)) return null;

  try {
    return readFileSync(txtPath, "utf-8");
  } catch {
    return null;
  }
}

function transformPage(page: PageData): SyncPage {
  const content = loadContent(page.numericId);

  return {
    id: page.id,
    numericId: page.numericId ?? null,
    title: page.title,
    description: page.description ?? null,
    llmSummary: page.llmSummary ?? null,
    category: page.category ?? null,
    subcategory: page.subcategory ?? null,
    entityType: page.entityType ?? null,
    tags: page.tags ? JSON.stringify(page.tags) : null,
    quality: page.quality ?? null,
    readerImportance: page.readerImportance != null ? Math.round(page.readerImportance) : null,
    hallucinationRiskLevel: page.hallucinationRisk?.level ?? null,
    hallucinationRiskScore: page.hallucinationRisk?.score ?? null,
    contentPlaintext: content,
    wordCount: page.wordCount ?? null,
    lastUpdated: page.lastUpdated ?? null,
    contentFormat: page.contentFormat ?? null,
  };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args["dry-run"] === true;
  const batchSize = Number(args["batch-size"]) || 50;

  const serverUrl = getServerUrl();
  const apiKey = getApiKey();

  if (!serverUrl) {
    console.error(
      "Error: LONGTERMWIKI_SERVER_URL environment variable is required"
    );
    process.exit(1);
  }
  if (!apiKey) {
    console.error(
      "Error: LONGTERMWIKI_SERVER_API_KEY environment variable is required"
    );
    process.exit(1);
  }

  // Load pages.json
  if (!existsSync(PAGES_JSON_PATH)) {
    console.error(
      `Error: ${PAGES_JSON_PATH} not found. Run 'node apps/web/scripts/build-data.mjs' first.`
    );
    process.exit(1);
  }

  const rawPages: PageData[] = JSON.parse(
    readFileSync(PAGES_JSON_PATH, "utf-8")
  );

  // Filter out internal/schema pages
  const filteredPages = rawPages.filter(
    (p) => p.category !== "internal" && p.category !== "schema"
  );

  console.log(
    `Syncing ${filteredPages.length} pages to ${serverUrl} (batch size: ${batchSize})`
  );

  // Transform pages
  const syncPayloads = filteredPages.map(transformPage);

  const withContent = syncPayloads.filter((p) => p.contentPlaintext);
  const totalContentSize = syncPayloads.reduce(
    (sum, p) => sum + (p.contentPlaintext?.length ?? 0),
    0
  );

  console.log(
    `  ${withContent.length}/${syncPayloads.length} pages have content (~${(totalContentSize / 1024 / 1024).toFixed(1)} MB)`
  );

  if (dryRun) {
    console.log("\n[dry-run] Would sync these pages:");
    for (const p of syncPayloads.slice(0, 10)) {
      console.log(`  ${p.id} (${p.numericId}) — ${p.title}`);
    }
    if (syncPayloads.length > 10) {
      console.log(`  ... and ${syncPayloads.length - 10} more`);
    }
    process.exit(0);
  }

  // Pre-sync health check
  console.log("\nChecking server health...");
  const healthy = await waitForHealthy(serverUrl);
  if (!healthy) {
    console.error(
      `Error: Server at ${serverUrl} is not healthy after ${HEALTH_CHECK_RETRIES} attempts. Aborting sync.`
    );
    process.exit(1);
  }

  // Sync
  const result = await syncPages(serverUrl, apiKey, syncPayloads, batchSize);

  console.log(`\nSync complete:`);
  console.log(`  Upserted: ${result.upserted}`);
  if (result.errors > 0) {
    console.log(`  Errors:  ${result.errors}`);
    console.error(
      `\nSync failed with ${result.errors} page errors. Check the batch error messages above for details.` +
        `\nIf errors show "internal_error", check the wiki-server pod logs: kubectl logs -l app=longterm-wiki-server --tail=100`
    );
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Sync failed:", err);
    process.exit(1);
  });
}
