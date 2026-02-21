/**
 * Shared utilities for fetching data from the wiki-server API
 * with automatic fallback to local data sources (YAML, database.json).
 *
 * Used by internal dashboard pages that display data from either
 * the wiki-server PostgreSQL database or local files.
 */

export type DataSource = "api" | "local";

export type ApiErrorReason =
  | { type: "not-configured" }
  | { type: "connection-error"; message: string }
  | { type: "server-error"; status: number; statusText: string };

export type FetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiErrorReason };

export interface WithSource<T> {
  data: T;
  source: DataSource;
  apiError?: ApiErrorReason;
}

/**
 * Fetch JSON from the wiki-server API with detailed error information.
 * Returns a discriminated union so callers can distinguish between
 * "not configured", "connection failed", and "server error".
 */
export async function fetchDetailed<T>(
  path: string,
  options?: { revalidate?: number }
): Promise<FetchResult<T>> {
  const config = getWikiServerConfig();
  if (!config) return { ok: false, error: { type: "not-configured" } };

  try {
    const res = await fetch(`${config.serverUrl}${path}`, {
      headers: config.headers,
      next: { revalidate: options?.revalidate ?? 300 },
    });
    if (!res.ok) {
      return {
        ok: false,
        error: {
          type: "server-error",
          status: res.status,
          statusText: res.statusText,
        },
      };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    return {
      ok: false,
      error: {
        type: "connection-error",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Fetch JSON from the wiki-server API.
 * Returns null if the server URL is not configured or the request fails.
 */
export async function fetchFromWikiServer<T>(
  path: string,
  options?: { revalidate?: number }
): Promise<T | null> {
  const result = await fetchDetailed<T>(path, options);
  return result.ok ? result.data : null;
}

/**
 * Returns the wiki-server URL and auth headers.
 * Useful for dashboards that need custom fetch logic (e.g. pagination).
 * Returns null if the server URL is not configured.
 */
export function getWikiServerConfig(): {
  serverUrl: string;
  headers: Record<string, string>;
} | null {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) return null;

  const headers: Record<string, string> = {};
  const apiKey = process.env.LONGTERMWIKI_SERVER_API_KEY;
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  return { serverUrl, headers };
}

/**
 * Try loading data from the wiki-server API, falling back to a local loader.
 * Returns the data along with its source ("api" or "local").
 *
 * The apiLoader can return either:
 * - `FetchResult<T>` (error-aware) — apiError is threaded through
 * - `T | null` (legacy) — no error detail available
 */
export async function withApiFallback<T>(
  apiLoader: () => Promise<FetchResult<T> | T | null>,
  localLoader: () => T
): Promise<WithSource<T>>;
export async function withApiFallback<T>(
  apiLoader: () => Promise<FetchResult<T> | T | null>,
  localLoader: () => T | null
): Promise<WithSource<T | null>>;
export async function withApiFallback<T>(
  apiLoader: () => Promise<FetchResult<T> | T | null>,
  localLoader: () => T | null
): Promise<WithSource<T | null>> {
  const result = await apiLoader();

  // Error-aware FetchResult path
  if (result !== null && typeof result === "object" && "ok" in result) {
    const fetchResult = result as FetchResult<T>;
    if (fetchResult.ok) {
      return { data: fetchResult.data, source: "api" };
    }
    return { data: localLoader(), source: "local", apiError: fetchResult.error };
  }

  // Legacy path: T | null
  if (result !== null) {
    return { data: result as T, source: "api" };
  }
  return { data: localLoader(), source: "local" };
}

/** Human-readable label for the data source, for dashboard footers. */
export function dataSourceLabel(source: DataSource): string {
  return source === "api" ? "wiki-server API" : "local files";
}
