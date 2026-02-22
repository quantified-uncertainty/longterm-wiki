/**
 * Resilience utilities: retry with backoff, progress heartbeat.
 *
 * Shared across authoring pipelines (page-improver, api-direct, etc.)
 * so that retry logic and heartbeat timers stay consistent.
 */

import { formatTime } from './output.ts';

/** Options for {@link withRetry}. */
export interface RetryOptions {
  maxRetries?: number;
  label?: string;
  /** Called on each retry with a human-readable message. Defaults to console.log. */
  onRetry?: (message: string) => void;
}

const RETRYABLE_PATTERNS = [
  'timeout',
  'ECONNRESET',
  'socket hang up',
  'overloaded',
  '529',
  '429',
  'rate_limit',
  'UND_ERR_SOCKET',
  'terminated',
];

/** Retry an async fn with exponential backoff (2 s, 4 s, …). */
export async function withRetry<T>(
  fn: () => Promise<T>,
  { maxRetries = 2, label = 'API call', onRetry }: RetryOptions = {}
): Promise<T> {
  const log = onRetry ?? ((msg: string) => console.log(`[retry] ${msg}`));

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      const isRetryable = RETRYABLE_PATTERNS.some((p) => error.message.includes(p));
      if (!isRetryable || attempt === maxRetries) throw err;
      const delay = Math.pow(2, attempt + 1) * 1000; // 2s, 4s
      log(
        `${label} failed (${error.message.slice(0, 80)}), retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})…`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error('unreachable');
}

/** Start a heartbeat timer that logs periodically. Returns a stop function. */
export function startHeartbeat(
  phase: string,
  intervalSec = 30,
  writer: (msg: string) => void = (msg) => process.stderr.write(msg + '\n')
): () => void {
  const start = Date.now();
  const timer = setInterval(() => {
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    writer(`[${formatTime()}] [${phase}] … still running (${elapsed}s)`);
  }, intervalSec * 1000);
  return () => clearInterval(timer);
}
