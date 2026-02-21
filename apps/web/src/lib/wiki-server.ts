/**
 * Shared utilities for fetching data from the wiki-server API
 * with automatic fallback to local data sources (YAML, database.json).
 *
 * Used by internal dashboard pages that display data from either
 * the wiki-server PostgreSQL database or local files.
 */

export type DataSource = "api" | "local";

export interface WithSource<T> {
  data: T;
  source: DataSource;
}

/**
 * Fetch JSON from the wiki-server API.
 * Returns null if the server URL is not configured or the request fails.
 */
export async function fetchFromWikiServer<T>(
  path: string,
  options?: { revalidate?: number }
): Promise<T | null> {
  const config = getWikiServerConfig();
  if (!config) return null;

  try {
    const res = await fetch(`${config.serverUrl}${path}`, {
      headers: config.headers,
      next: { revalidate: options?.revalidate ?? 300 },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
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
 */
export async function withApiFallback<T>(
  apiLoader: () => Promise<T | null>,
  localLoader: () => T
): Promise<WithSource<T>>;
export async function withApiFallback<T>(
  apiLoader: () => Promise<T | null>,
  localLoader: () => T | null
): Promise<WithSource<T | null>>;
export async function withApiFallback<T>(
  apiLoader: () => Promise<T | null>,
  localLoader: () => T | null
): Promise<WithSource<T | null>> {
  const apiData = await apiLoader();
  if (apiData !== null) {
    return { data: apiData, source: "api" };
  }
  return { data: localLoader(), source: "local" };
}

/** Human-readable label for the data source, for dashboard footers. */
export function dataSourceLabel(source: DataSource): string {
  return source === "api" ? "wiki-server API" : "local files";
}
