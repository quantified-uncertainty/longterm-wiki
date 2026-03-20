/**
 * Wiki Server Client — Core HTTP primitives and error types
 *
 * Provides:
 *   - `ApiResult<T>` discriminated union for typed error handling
 *   - `apiRequest()` — shared fetch with timeout and error classification
 *   - `batchedRequest()` — batched fetch with configurable timeout
 *   - Configuration helpers (URL, API key, headers)
 *   - Health check
 *   - TLS bypass for ISP-level SNI filtering (WIKI_SERVER_TLS_BYPASS)
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

import * as https from 'node:https';
import * as dns from 'node:dns/promises';

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

export type ApiError = 'unavailable' | 'timeout' | 'bad_request' | 'auth_error' | 'server_error';

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
  if (status >= 400 && status < 500) return 'bad_request';
  return 'server_error';
}

// ---------------------------------------------------------------------------
// TLS bypass for ISP SNI filtering
// ---------------------------------------------------------------------------

/**
 * Whether TLS bypass is enabled. When set, HTTPS requests to the wiki-server
 * connect directly to the resolved IP with a dummy TLS servername, bypassing
 * ISP-level SNI filtering (e.g., Comcast/Xfinity safebrowse.io interception).
 *
 * The real hostname is sent via the Host header so K8s nginx ingress routes
 * correctly. Certificate verification is disabled since the K8s ingress
 * serves a default cert that won't match the hostname.
 */
function isTlsBypassEnabled(): boolean {
  return process.env.WIKI_SERVER_TLS_BYPASS === 'true';
}

/** DNS resolution cache to avoid repeated lookups. */
let resolvedIpCache: { hostname: string; ip: string; expiry: number } | null = null;

async function resolveHostnameToIp(hostname: string): Promise<string> {
  const now = Date.now();
  if (resolvedIpCache && resolvedIpCache.hostname === hostname && now < resolvedIpCache.expiry) {
    return resolvedIpCache.ip;
  }
  const { address } = await dns.lookup(hostname);
  resolvedIpCache = { hostname, ip: address, expiry: now + 5 * 60 * 1000 }; // 5-min TTL
  return address;
}

/**
 * Fetch via node:https with TLS bypass — connects to the resolved IP with
 * a dummy SNI to avoid ISP-level domain blocking.
 */
async function tlsBypassFetch(
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    timeoutMs: number;
  },
): Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }> {
  const parsed = new URL(url);
  const hostname = parsed.hostname;
  const ip = await resolveHostnameToIp(hostname);
  const port = parsed.port ? parseInt(parsed.port, 10) : 443;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new DOMException('The operation was aborted', 'AbortError'));
    }, init.timeoutMs);

    const req = https.request(
      {
        hostname: ip,
        port,
        path: parsed.pathname + parsed.search,
        method: init.method,
        rejectUnauthorized: false,
        servername: 'internal', // Dummy SNI to bypass ISP filtering
        headers: { ...init.headers, Host: hostname },
      },
      (res) => {
        clearTimeout(timer);
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => {
          const status = res.statusCode ?? 500;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            text: async () => body,
            json: async () => JSON.parse(body),
          });
        });
      },
    );
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    if (init.body) req.write(init.body);
    req.end();
  });
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
): Promise<ApiResult<T>> {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    const prefix = getEnvPrefix();
    return apiErr('unavailable', `${prefix}LONGTERMWIKI_SERVER_URL not set`);
  }

  const fullUrl = `${serverUrl}${path}`;
  const useTlsBypass = isTlsBypassEnabled() && serverUrl.startsWith('https://');

  try {
    const headers = buildHeaders();
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;

    let res: { ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> };

    if (useTlsBypass) {
      res = await tlsBypassFetch(fullUrl, {
        method,
        headers,
        body: bodyStr,
        timeoutMs,
      });
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const fetchRes = await fetch(fullUrl, {
        method,
        headers,
        body: bodyStr,
        signal: controller.signal,
      });
      clearTimeout(timer);
      res = fetchRes;
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
// Shared server fetch — exported for health-check.ts and other callers
// ---------------------------------------------------------------------------

/**
 * Fetch a URL from the wiki-server, using TLS bypass when enabled.
 * This is the recommended way for any code outside this module to make
 * wiki-server requests when they can't use apiRequest() directly.
 */
export async function serverFetch(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number },
): Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }> {
  const method = init?.method ?? 'GET';
  const headers = init?.headers ?? {};
  const timeoutMs = init?.timeoutMs ?? TIMEOUT_MS;

  if (isTlsBypassEnabled() && url.startsWith('https://')) {
    return tlsBypassFetch(url, { method, headers, body: init?.body, timeoutMs });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const res = await fetch(url, {
    method,
    headers,
    body: init?.body,
    signal: controller.signal,
  });
  clearTimeout(timer);
  return res;
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
    const fullUrl = `${serverUrl}/health`;
    const useTlsBypass = isTlsBypassEnabled() && serverUrl.startsWith('https://');

    let res: { ok: boolean; json: () => Promise<unknown> };

    if (useTlsBypass) {
      res = await tlsBypassFetch(fullUrl, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        timeoutMs: TIMEOUT_MS,
      });
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const fetchRes = await fetch(fullUrl, { signal: controller.signal });
      clearTimeout(timer);
      res = fetchRes;
    }

    if (!res.ok) return false;

    const body = (await res.json()) as { status?: string };
    return body.status === 'healthy';
  } catch {
    return false;
  }
}
