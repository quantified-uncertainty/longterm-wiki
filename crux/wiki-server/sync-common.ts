/**
 * Shared batch sync infrastructure for wiki-server sync scripts.
 *
 * Contains:
 *   - waitForHealthy(): Pre-sync health check with retries
 *   - fetchWithRetry(): Per-request retry with exponential backoff
 *   - batchSync<T>(): Generic batch sync loop with consecutive failure detection
 *
 * Each sync script defines its own data loading, transformation, and CLI,
 * then delegates the actual sync loop to batchSync().
 */

import { buildHeaders } from "../lib/wiki-server/client.ts";

// --- Configuration ---
const HEALTH_CHECK_RETRIES = 5;
const HEALTH_CHECK_DELAY_MS = 10_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const BATCH_RETRY_ATTEMPTS = 3;
const BATCH_RETRY_BASE_DELAY_MS = 2_000;
const BATCH_TIMEOUT_MS = 30_000;
export const MAX_CONSECUTIVE_FAILURES = 3;

// --- Types ---

export interface BatchSyncOptions<T> {
  /**
   * Key to wrap items under in the request body.
   * E.g., "pages" produces `{ pages: batch }`.
   * If null, sends `batch[0]` directly (for single-item endpoints).
   */
  bodyKey: string | null;
  /**
   * Key in the response JSON containing the success count.
   * If null, counts batch.length on success. Default: "upserted"
   */
  responseCountKey?: string | null;
  /** Label for the items in log/error messages (e.g., "pages", "entities"). Default: "items" */
  itemLabel?: string;
  /** Called after a non-ok response for additional error handling (e.g., parsing JSON error messages) */
  onBatchError?: (body: string) => void;
  /** Custom success logger. If not provided, default log is used. */
  onBatchSuccess?: (
    responseJson: Record<string, unknown>,
    batch: T[],
    batchNum: number,
    totalBatches: number,
    count: number,
  ) => void;
  _sleep?: (ms: number) => Promise<void>;
}

export interface BatchSyncResult {
  /** Number of items successfully processed */
  count: number;
  /** Number of items that errored */
  errors: number;
}

// --- Health check ---

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

// --- Fetch with retry ---

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

// --- Batch sync ---

/**
 * Generic batch sync loop that handles batching, retry, consecutive failure
 * detection, and progress logging.
 *
 * Each sync script calls this with its endpoint URL, items, batch size, and
 * configuration (body key, response key, etc.), then maps the result to its
 * own return type.
 */
export async function batchSync<T>(
  url: string,
  items: T[],
  batchSize: number,
  options: BatchSyncOptions<T>,
): Promise<BatchSyncResult> {
  const {
    bodyKey,
    responseCountKey = "upserted",
    itemLabel = "items",
    onBatchError,
    onBatchSuccess,
    _sleep,
  } = options;

  let totalCount = 0;
  let totalErrors = 0;
  let consecutiveFailures = 0;

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(items.length / batchSize);

    try {
      const requestBody =
        bodyKey !== null
          ? JSON.stringify({ [bodyKey]: batch })
          : JSON.stringify(batch[0]);

      const res = await fetchWithRetry(
        url,
        {
          method: "POST",
          headers: buildHeaders(),
          body: requestBody,
        },
        { _sleep },
      );

      if (!res.ok) {
        const resBody = await res.text();
        console.error(
          `  Batch ${batchNum}/${totalBatches}: HTTP ${res.status} — ${resBody}`,
        );
        onBatchError?.(resBody);
        totalErrors += batch.length;
        consecutiveFailures++;
      } else {
        const result = (await res.json()) as Record<string, unknown>;
        const count =
          responseCountKey !== null
            ? (result[responseCountKey] as number)
            : batch.length;
        totalCount += count;
        consecutiveFailures = 0;

        if (onBatchSuccess) {
          onBatchSuccess(result, batch, batchNum, totalBatches, count);
        } else {
          const verb = responseCountKey ?? "synced";
          console.log(
            `  Batch ${batchNum}/${totalBatches}: ${count} ${verb}`,
          );
        }
      }
    } catch (err) {
      console.error(
        `  Batch ${batchNum}/${totalBatches}: Failed after retries — ${err}`,
      );
      totalErrors += batch.length;
      consecutiveFailures++;
    }

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      const remaining = items.length - (i + batchSize);
      if (remaining > 0) {
        console.error(
          `\n  Aborting: ${MAX_CONSECUTIVE_FAILURES} consecutive batch failures. ` +
            `Skipping ${remaining} remaining ${itemLabel}.`,
        );
        totalErrors += remaining;
      }
      break;
    }
  }

  return { count: totalCount, errors: totalErrors };
}
