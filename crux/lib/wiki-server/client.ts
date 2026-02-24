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

const TIMEOUT_MS = 5_000;
export const BATCH_TIMEOUT_MS = 30_000;

/** API key scope — determines which env var to prefer for authentication. */
export type ApiKeyScope = 'project' | 'content';

export function getServerUrl(): string {
  return process.env.LONGTERMWIKI_SERVER_URL || '';
}

/**
 * Get the API key for a given scope.
 *
 * Resolution order:
 *   - 'project' → LONGTERMWIKI_PROJECT_KEY, then LONGTERMWIKI_SERVER_API_KEY
 *   - 'content' → LONGTERMWIKI_CONTENT_KEY, then LONGTERMWIKI_SERVER_API_KEY
 *   - undefined  → LONGTERMWIKI_SERVER_API_KEY (backward compatible)
 */
export function getApiKey(scope?: ApiKeyScope): string {
  if (scope === 'project') {
    return process.env.LONGTERMWIKI_PROJECT_KEY
      || process.env.LONGTERMWIKI_SERVER_API_KEY
      || '';
  }
  if (scope === 'content') {
    return process.env.LONGTERMWIKI_CONTENT_KEY
      || process.env.LONGTERMWIKI_SERVER_API_KEY
      || '';
  }
  // No scope specified — use legacy key (backward compatible)
  return process.env.LONGTERMWIKI_SERVER_API_KEY || '';
}

/**
 * Build HTTP headers with the appropriate API key for the given scope.
 * If no scope is provided, uses the legacy key for backward compatibility.
 */
export function buildHeaders(scope?: ApiKeyScope): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = getApiKey(scope);
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// ApiResult — discriminated union for typed errors
// ---------------------------------------------------------------------------

export type ApiError = 'unavailable' | 'timeout' | 'bad_request' | 'server_error';

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
  if (status >= 400 && status < 500) return 'bad_request';
  return 'server_error';
}

// ---------------------------------------------------------------------------
// Core request function
// ---------------------------------------------------------------------------

/**
 * Make a JSON request to the wiki-server API.
 * Returns an `ApiResult<T>` with typed error discrimination.
 */
export async function apiRequest<T>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  timeoutMs: number = TIMEOUT_MS,
  scope?: ApiKeyScope,
): Promise<ApiResult<T>> {
  const serverUrl = getServerUrl();
  if (!serverUrl) return apiErr('unavailable', 'LONGTERMWIKI_SERVER_URL not set');

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const options: RequestInit = {
      method,
      headers: buildHeaders(scope),
      signal: controller.signal,
    };

    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(`${serverUrl}${path}`, options);
    clearTimeout(timer);

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
  scope?: ApiKeyScope,
): Promise<ApiResult<T>> {
  return apiRequest<T>(method, path, body, timeoutMs, scope);
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
