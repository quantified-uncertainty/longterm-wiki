/**
 * Wiki Server Client — Core HTTP primitives and error types
 *
 * Provides:
 *   - `ApiResult<T>` discriminated union for typed error handling
 *   - `apiRequest()` — shared fetch with timeout and error classification
 *   - `batchedRequest()` — batched fetch with configurable timeout
 *   - Configuration helpers (URL, API key, headers)
 *   - Health check
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

import {
  WIKI_SERVER_TIMEOUT_MS as TIMEOUT_MS,
  WIKI_SERVER_BATCH_TIMEOUT_MS as BATCH_TIMEOUT_MS,
} from '../config.ts';
export { BATCH_TIMEOUT_MS };

/**
 * Environment prefix for wiki-server env vars.
 *
 * Set `WIKI_SERVER_ENV=prod` to read from `PROD_LONGTERMWIKI_*` env vars
 * instead of the default `LONGTERMWIKI_*`. This lets you have both a
 * local dev server and prod configured in `.env` and switch with one var.
 *
 *   WIKI_SERVER_ENV=prod pnpm crux query search "anthropic"
 */
function getEnvPrefix(): string {
  const env = process.env.WIKI_SERVER_ENV;
  if (env === 'prod' || env === 'production') return 'PROD_';
  return '';
}

export function getServerUrl(): string {
  const prefix = getEnvPrefix();
  return process.env[`${prefix}LONGTERMWIKI_SERVER_URL`] || '';
}

/**
 * Get the API key. Respects the WIKI_SERVER_ENV=prod prefix.
 */
export function getApiKey(): string {
  const prefix = getEnvPrefix();
  return process.env[`${prefix}LONGTERMWIKI_SERVER_API_KEY`] || '';
}

/**
 * Build HTTP headers with the API key for wiki-server requests.
 */
export function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = getApiKey();
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// ApiResult — discriminated union for typed errors
// ---------------------------------------------------------------------------

export type ApiError = 'unavailable' | 'timeout' | 'bad_request' | 'auth_error' | 'server_error' | 'rate_limited';

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError; message: string };

export function apiOk<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

export function apiErr<T>(error: ApiError, message: string): ApiResult<T> {
  return { ok: false, error, message };
}

/** Unwrap an ApiResult to the old `T | null` shape for backward compatibility. */
export function unwrap<T>(result: ApiResult<T>): T | null {
  return result.ok ? result.data : null;
}

// ---------------------------------------------------------------------------
// Classify HTTP status codes into ApiError categories
// ---------------------------------------------------------------------------

function classifyStatus(status: number): ApiError {
  if (status === 401 || status === 403) return 'auth_error';
  if (status === 429) return 'rate_limited';
  if (status >= 400 && status < 500) return 'bad_request';
  return 'server_error';
}

/** Max retries for rate-limited requests */
const MAX_RATE_LIMIT_RETRIES = 3;

// ---------------------------------------------------------------------------
// Core request function
// ---------------------------------------------------------------------------

/**
 * Make a JSON request to the wiki-server API.
 * Returns an `ApiResult<T>` with typed error discrimination.
 * Automatically retries on 429 (rate limit) with backoff from the
 * `x-ratelimit-reset` header.
 */
export async function apiRequest<T>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  timeoutMs: number = TIMEOUT_MS,
): Promise<ApiResult<T>> {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    const prefix = getEnvPrefix();
    return apiErr('unavailable', `${prefix}LONGTERMWIKI_SERVER_URL not set`);
  }

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const options: RequestInit = {
        method,
        headers: buildHeaders(),
        signal: controller.signal,
      };

      if (body !== undefined) {
        options.body = JSON.stringify(body);
      }

      const res = await fetch(`${serverUrl}${path}`, options);
      clearTimeout(timer);

      if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        // Rate limited — wait for reset and retry
        const resetEpoch = Number(res.headers.get('x-ratelimit-reset'));
        const waitMs = resetEpoch
          ? Math.max(0, resetEpoch * 1000 - Date.now()) + 500 // 500ms buffer
          : (attempt + 1) * 2000; // Exponential fallback: 2s, 4s, 6s
        await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, 30_000)));
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return apiErr(classifyStatus(res.status), `${res.status}: ${text.slice(0, 500)}`);
      }

      return apiOk((await res.json()) as T);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return apiErr('timeout', `Request to ${path} timed out after ${timeoutMs}ms`);
      }
      const message = err instanceof Error ? err.message : String(err);
      // Network errors (ECONNREFUSED, DNS failures, etc.) → unavailable
      return apiErr('unavailable', message);
    }
  }

  return apiErr('rate_limited', `Rate limited after ${MAX_RATE_LIMIT_RETRIES} retries on ${path}`);
}

/**
 * Make a raw fetch to the wiki-server with batch-level timeout.
 * Returns an `ApiResult<T>` with typed error discrimination.
 *
 * Used by endpoints that need larger timeouts or manual batching.
 */
export async function batchedRequest<T>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  timeoutMs: number = BATCH_TIMEOUT_MS,
): Promise<ApiResult<T>> {
  return apiRequest<T>(method, path, body, timeoutMs);
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

/**
 * Check if the wiki-server is reachable and healthy.
 */
export async function isServerAvailable(): Promise<boolean> {
  const serverUrl = getServerUrl();
  if (!serverUrl) return false;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(`${serverUrl}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return false;

    const body = await res.json();
    return body.status === 'healthy';
  } catch {
    return false;
  }
}
