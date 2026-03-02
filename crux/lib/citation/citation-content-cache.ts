/**
 * Session-local in-memory cache for citation content.
 *
 * PG (wiki-server) is the durable store; this avoids redundant API calls
 * within a single CLI session.
 *
 * The cache is a simple Map keyed by URL with LRU eviction.
 */

const MAX_ENTRIES = 500;

export interface CachedCitationContent {
  url: string;
  fetchedAt: string;
  httpStatus: number | null;
  contentType: string | null;
  pageTitle: string | null;
  fullText: string | null;
  contentLength: number | null;
}

const cache = new Map<string, CachedCitationContent>();
let evictionCount = 0;

/** Get cached content for a URL. Returns null if not in cache. */
export function getCachedContent(url: string): CachedCitationContent | null {
  const entry = cache.get(url);
  if (!entry) return null;
  // Move to end (refresh LRU position)
  cache.delete(url);
  cache.set(url, entry);
  return entry;
}

/** Store content in the session cache with LRU eviction. */
export function setCachedContent(url: string, entry: CachedCitationContent): void {
  if (cache.has(url)) {
    cache.delete(url);
  }
  cache.set(url, entry);

  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
      evictionCount++;
    }
  }
}

/** Clear the cache (useful in tests). */
export function clearContentCache(): void {
  cache.clear();
  evictionCount = 0;
}

/** Number of entries in cache (for diagnostics). */
export function contentCacheSize(): number {
  return cache.size;
}

/** Number of LRU evictions (for diagnostics). */
export function contentCacheEvictions(): number {
  return evictionCount;
}
