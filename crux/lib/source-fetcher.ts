/**
 * Source Fetcher — fetch & extract content from URLs
 *
 * Foundational module for content-grounded citation verification and research.
 * Fetches source URLs, converts HTML to clean text/markdown, extracts relevant
 * excerpts for a query, and caches results to avoid redundant network calls.
 *
 * Fetching strategy:
 *   1. Firecrawl (if FIRECRAWL_KEY set) — high-quality HTML→markdown
 *   2. Built-in fetch fallback — plain-text extraction from HTML
 *
 * Caching strategy:
 *   - In-memory Map for session-level deduplication (cleared on process exit)
 *   - PostgreSQL (wiki-server) citation_content.full_text — durable cross-machine cache
 *   - SQLite citation_content table — fast local fallback
 *
 * Usage:
 *   import { fetchSource, fetchSources, extractRelevantExcerpts } from './source-fetcher.ts';
 *
 *   const source = await fetchSource({ url: 'https://example.com', extractMode: 'relevant', query: 'AI safety funding' });
 *   // source.status === 'ok' | 'paywall' | 'dead' | 'error'
 *   // source.content — cleaned markdown/text of the page
 *   // source.relevantExcerpts — paragraphs matching the query
 *
 * Integration: used by citations/verify-citations.ts, auto-update, research-agent.
 * See issue #633.
 */

import { getApiKey } from './api-keys.ts';
import { citationContent } from './knowledge-db.ts';
import {
  upsertCitationContent,
  getCitationContentByUrl,
} from './wiki-server/citations.ts';
import {
  getResourceById,
  getResourceByUrl,
  updateResourceFetchStatus,
  type ResourceEntry,
} from './resource-lookup.ts';

// ---------------------------------------------------------------------------
// Public interfaces (spec from issue #633)
// ---------------------------------------------------------------------------

export interface FetchRequest {
  /** URL to fetch. Can be omitted if resourceId is provided (URL is inherited from resource). */
  url?: string;
  /** 'full' returns the whole page content; 'relevant' also extracts excerpts */
  extractMode: 'full' | 'relevant';
  /** Required when extractMode === 'relevant' */
  query?: string;
  /** Optional resource ID — inherits URL/title/description from resource YAML. */
  resourceId?: string;
  /** If true, write fetch status (dead/paywall/ok) back to the resource YAML. Default: false. */
  updateResourceStatus?: boolean;
}

export type FetchedSourceStatus = 'ok' | 'paywall' | 'dead' | 'error';

export interface FetchedSource {
  url: string;
  title: string;
  fetchedAt: string;
  /** Cleaned markdown (Firecrawl) or plain text (fallback) of the page */
  content: string;
  /** Paragraphs from content most relevant to the query (empty if no query or extractMode=full) */
  relevantExcerpts: string[];
  status: FetchedSourceStatus;
  /** Resource metadata, present when the URL matched a known resource */
  resource?: {
    id: string;
    title: string;
    type: string;
    summary?: string;
    authors?: string[];
    tags?: string[];
  };
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Domains that block all automated access — skip fetch */
const UNVERIFIABLE_DOMAINS = [
  'twitter.com', 'x.com', 'linkedin.com', 'facebook.com', 't.co',
  'instagram.com', 'tiktok.com',
];

/** Keywords indicating a paywall or login wall */
const PAYWALL_SIGNALS = [
  'subscribe to read', 'sign in to read', 'create a free account',
  'this content is for subscribers', 'subscriber-only', 'paywall',
  'to continue reading', 'unlimited access', 'login required',
  'please sign in', 'register to read',
];

const FETCH_TIMEOUT_MS = 15_000;
const FETCH_USER_AGENT = 'Mozilla/5.0 (compatible; LongtermWikiSourceFetcher/1.0)';
const MAX_CONTENT_CHARS = 100_000;

/** Common English stopwords filtered out during query tokenization. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'are', 'was', 'with', 'from', 'this', 'has',
  'have', 'had', 'its', 'not', 'but', 'can', 'all', 'one', 'more', 'also',
  'about', 'into', 'such', 'than', 'then', 'when', 'which', 'will', 'been',
]);

// ---------------------------------------------------------------------------
// Session-level in-memory cache with LRU eviction (#650)
// ---------------------------------------------------------------------------

const SESSION_CACHE_MAX_ENTRIES = 500;

/** Keyed by URL. Uses insertion-order of Map for LRU eviction. */
const sessionCache = new Map<string, FetchedSource>();

/** In-flight fetch promises for deduplication (#650). */
const inFlightFetches = new Map<string, Promise<FetchedSource>>();

/** Cumulative eviction counter (for diagnostics). */
let _evictionCount = 0;

/** Clear the in-memory cache and in-flight map (useful in tests). */
export function clearSessionCache(): void {
  sessionCache.clear();
  inFlightFetches.clear();
  _evictionCount = 0;
}

/** Number of entries in the session cache (for tests and diagnostics). */
export function sessionCacheSize(): number {
  return sessionCache.size;
}

/** Number of LRU evictions since last cache clear (for diagnostics). */
export function sessionCacheEvictions(): number {
  return _evictionCount;
}

/**
 * Add an entry to the session cache with LRU eviction.
 * When the cache exceeds MAX_ENTRIES, the oldest entry is removed.
 */
function sessionCacheSet(url: string, value: FetchedSource): void {
  // Move to end if already present (refresh LRU position)
  if (sessionCache.has(url)) {
    sessionCache.delete(url);
  }
  sessionCache.set(url, value);

  // Evict oldest entries if over limit
  while (sessionCache.size > SESSION_CACHE_MAX_ENTRIES) {
    const oldest = sessionCache.keys().next().value;
    if (oldest !== undefined) {
      sessionCache.delete(oldest);
      _evictionCount++;
    }
  }
}

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isUnverifiable(url: string): boolean {
  const domain = getDomain(url);
  return UNVERIFIABLE_DOMAINS.some(d => domain === d || domain.endsWith('.' + d));
}

// ---------------------------------------------------------------------------
// HTML-to-text conversion (fallback when Firecrawl unavailable)
// ---------------------------------------------------------------------------

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return '';
  return m[1]
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Paywall detection
// ---------------------------------------------------------------------------

function detectPaywall(content: string): boolean {
  if (!content) return false;
  const lower = content.toLowerCase();
  // Short content (< 500 chars) plus at least one paywall signal
  if (content.length < 500) {
    return PAYWALL_SIGNALS.some(s => lower.includes(s));
  }
  // Longer content: paywall signal must appear early (first 2000 chars)
  const early = lower.slice(0, 2000);
  const signalCount = PAYWALL_SIGNALS.filter(s => early.includes(s)).length;
  return signalCount >= 2;
}

// ---------------------------------------------------------------------------
// Relevant excerpt extraction
// ---------------------------------------------------------------------------

/**
 * Score a paragraph against a query using simple keyword overlap.
 * Returns a float in [0, 1].
 */
function scoreParagraph(paragraph: string, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const lower = paragraph.toLowerCase();
  const hits = queryTokens.filter(t => lower.includes(t)).length;
  return hits / queryTokens.length;
}

/**
 * Tokenize a query string into normalized keywords (length ≥ 3, no stopwords).
 */
function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\W+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Split content into paragraphs and return the top-N most relevant ones.
 *
 * Returns at most `maxExcerpts` paragraphs (default 5) with score > 0,
 * sorted by relevance descending.
 */
export function extractRelevantExcerpts(
  content: string,
  query: string,
  maxExcerpts = 5,
): string[] {
  if (!query.trim()) return [];

  const queryTokens = tokenizeQuery(query);
  if (queryTokens.length === 0) return [];

  // Split on double newlines (paragraphs) or single newlines
  const paragraphs = content
    .split(/\n\n+/)
    .map(p => p.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(p => p.length > 40); // skip very short fragments

  const scored = paragraphs
    .map(p => ({ text: p, score: scoreParagraph(p, queryTokens) }))
    .filter(e => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxExcerpts);

  return scored.map(e => e.text);
}

// ---------------------------------------------------------------------------
// Firecrawl fetch
// ---------------------------------------------------------------------------

interface FirecrawlResult {
  title: string;
  content: string; // markdown
}

async function fetchWithFirecrawl(url: string): Promise<FirecrawlResult | null> {
  const FIRECRAWL_KEY = getApiKey('FIRECRAWL_KEY');
  if (!FIRECRAWL_KEY) return null;

  try {
    // @ts-expect-error — @mendable/firecrawl-js has no bundled type declarations in crux
    const FirecrawlApp = (await import('@mendable/firecrawl-js')).default;
    const firecrawl = new FirecrawlApp({ apiKey: FIRECRAWL_KEY });
    const result = await firecrawl.scrape(url, { formats: ['markdown'] });

    if (result.markdown && result.markdown.length > 0) {
      const meta = (result as { metadata?: { title?: string } }).metadata;
      return {
        title: meta?.title ?? '',
        content: result.markdown.slice(0, MAX_CONTENT_CHARS),
      };
    }
    return null;
  } catch {
    // Firecrawl unavailable or failed — fall through to built-in fetch
    return null;
  }
}

// ---------------------------------------------------------------------------
// Built-in fetch (fallback)
// ---------------------------------------------------------------------------

interface BuiltinFetchResult {
  title: string;
  content: string;
  httpStatus: number;
  error: string | null;
}

async function fetchWithBuiltin(url: string): Promise<BuiltinFetchResult> {
  const MAX_RETRIES = 2;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': FETCH_USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow',
      });

      const status = response.status;

      // Retry on 5xx / 429
      if ((status >= 500 || status === 429) && attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt + 1) * 1000));
        continue;
      }

      if (!response.ok) {
        return { title: '', content: '', httpStatus: status, error: `HTTP ${status}` };
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/pdf')) {
        return { title: '(PDF)', content: '', httpStatus: status, error: 'PDF content' };
      }
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        return { title: '', content: '', httpStatus: status, error: `non-HTML: ${contentType}` };
      }

      const html = await response.text();
      const title = extractTitle(html);
      const text = htmlToText(html).slice(0, MAX_CONTENT_CHARS);

      return { title, content: text, httpStatus: status, error: null };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient = msg.includes('abort') || msg.includes('ECONNRESET') || msg.includes('timeout');

      if (isTransient && attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt + 1) * 1000));
        continue;
      }

      return {
        title: '', content: '', httpStatus: 0,
        error: msg.includes('abort') ? 'timeout' : msg,
      };
    }
  }

  return { title: '', content: '', httpStatus: 0, error: 'max retries exceeded' };
}

// ---------------------------------------------------------------------------
// SQLite cross-session cache helpers
// ---------------------------------------------------------------------------

/** Try to load a previously fetched result from SQLite. */
function loadFromDb(url: string): Pick<FetchedSource, 'title' | 'content' | 'fetchedAt'> | null {
  try {
    const row = citationContent.getByUrl(url);
    if (row?.full_text && row.full_text.length > 0) {
      return {
        title: row.page_title ?? '',
        content: row.full_text,
        fetchedAt: row.fetched_at ?? new Date().toISOString(),
      };
    }
  } catch {
    // DB unavailable — fine, proceed without cache
  }
  return null;
}

/** Store fetched content in SQLite for cross-session reuse. */
function saveToDb(url: string, title: string, content: string, httpStatus: number): void {
  try {
    citationContent.upsert({
      url,
      pageId: '_source-fetcher',
      footnote: 0,
      fetchedAt: new Date().toISOString(),
      httpStatus,
      contentType: 'text/html',
      pageTitle: title,
      fullHtml: null,
      fullText: content,
      contentLength: content.length,
    });
  } catch {
    // SQLite storage is best-effort
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL cross-machine cache helpers
// ---------------------------------------------------------------------------

/**
 * Try to load a previously fetched result from PostgreSQL (wiki-server).
 * Returns null if the server is unavailable or the URL has not been cached.
 * apiRequest never throws — it returns { ok: false } on network/server errors.
 */
async function loadFromPostgres(
  url: string,
): Promise<(Pick<FetchedSource, 'title' | 'content' | 'fetchedAt'> & { httpStatus: number | null }) | null> {
  const result = await getCitationContentByUrl(url);
  if (result.ok && result.data.fullText && result.data.fullText.length > 0) {
    return {
      title: result.data.pageTitle ?? '',
      content: result.data.fullText,
      fetchedAt: result.data.fetchedAt,
      httpStatus: result.data.httpStatus ?? null,
    };
  }
  return null;
}

/**
 * Fire-and-forget write of fetched content to PostgreSQL.
 * Errors are silently ignored — PostgreSQL is a durable secondary store,
 * not a hard dependency.
 */
function saveToPostgres(url: string, title: string, content: string, httpStatus: number): void {
  upsertCitationContent({
    url,
    fetchedAt: new Date().toISOString(),
    httpStatus,
    contentType: 'text/html',
    pageTitle: title || null,
    fullText: content,
    contentLength: content.length,
  }).catch(() => {
    // Best-effort — don't fail if server unavailable
  });
}

// ---------------------------------------------------------------------------
// Resource resolution
// ---------------------------------------------------------------------------

/** Build a resource metadata snippet for the FetchedSource response. */
function buildResourceMeta(r: ResourceEntry): FetchedSource['resource'] {
  return {
    id: r.id,
    title: r.title,
    type: r.type,
    summary: r.summary,
    authors: r.authors,
    tags: r.tags,
  };
}

/**
 * Resolve a FetchRequest to a concrete URL and optional resource entry.
 *
 * Resolution order:
 *   1. If resourceId is given, look up by ID → get URL + metadata
 *   2. If url is given, optionally look up by URL for metadata
 *   3. If neither, throw
 */
function resolveRequest(request: FetchRequest): { url: string; resource: ResourceEntry | null } {
  let resource: ResourceEntry | null = null;

  if (request.resourceId) {
    resource = getResourceById(request.resourceId);
    if (resource) {
      return { url: request.url ?? resource.url, resource };
    }
    // resourceId given but not found — fall through to URL
  }

  const url = request.url;
  if (!url) {
    throw new Error('FetchRequest requires either url or a valid resourceId');
  }

  // Try to find resource metadata by URL
  resource = getResourceByUrl(url);

  return { url, resource };
}

// ---------------------------------------------------------------------------
// Core fetch function
// ---------------------------------------------------------------------------

/**
 * Internal: perform the actual fetch (cache → SQLite → network → store).
 * Separated from fetchSource so in-flight deduplication can wrap it.
 */
async function _fetchSourceCore(
  url: string,
  resource: ResourceEntry | null,
  resourceMeta: FetchedSource['resource'],
  request: FetchRequest,
): Promise<FetchedSource> {
  const { extractMode, query } = request;
  const now = new Date().toISOString();

  // ---- 1. Unverifiable domains ----
  if (isUnverifiable(url)) {
    const result: FetchedSource = {
      url, title: resource?.title ?? '', fetchedAt: now, content: '',
      relevantExcerpts: [], status: 'error', resource: resourceMeta,
    };
    sessionCacheSet(url, result);
    return result;
  }

  // ---- 2. PostgreSQL cross-machine cache (async, durable source of truth) ----
  const pgRow = await loadFromPostgres(url);
  if (pgRow) {
    const excerpts = extractMode === 'relevant' && query
      ? extractRelevantExcerpts(pgRow.content, query)
      : [];
    const paywall = detectPaywall(pgRow.content);
    const result: FetchedSource = {
      url,
      title: pgRow.title || resource?.title || '',
      fetchedAt: pgRow.fetchedAt,
      content: pgRow.content,
      relevantExcerpts: excerpts,
      status: paywall ? 'paywall' : 'ok',
      resource: resourceMeta,
    };
    // Backfill SQLite so subsequent calls are served from the fast local cache
    saveToDb(url, pgRow.title, pgRow.content, pgRow.httpStatus ?? 200);
    sessionCacheSet(url, result);
    return result;
  }

  // ---- 3. SQLite local cache (fast fallback when PostgreSQL is unavailable) ----
  const dbRow = loadFromDb(url);
  if (dbRow) {
    const excerpts = extractMode === 'relevant' && query
      ? extractRelevantExcerpts(dbRow.content, query)
      : [];
    const paywall = detectPaywall(dbRow.content);
    const result: FetchedSource = {
      url,
      title: dbRow.title || resource?.title || '',
      fetchedAt: dbRow.fetchedAt,
      content: dbRow.content,
      relevantExcerpts: excerpts,
      status: paywall ? 'paywall' : 'ok',
      resource: resourceMeta,
    };
    sessionCacheSet(url, result);
    return result;
  }

  // ---- 4. Network fetch (Firecrawl → built-in fallback) ----
  let title = '';
  let content = '';
  let httpStatus = 0;
  let fetchError: string | null = null;

  const firecrawlResult = await fetchWithFirecrawl(url);
  if (firecrawlResult) {
    title = firecrawlResult.title;
    content = firecrawlResult.content;
    httpStatus = 200;
  } else {
    const builtinResult = await fetchWithBuiltin(url);
    title = builtinResult.title;
    content = builtinResult.content;
    httpStatus = builtinResult.httpStatus;
    fetchError = builtinResult.error;
  }

  // ---- 4. Determine status ----
  let status: FetchedSourceStatus;
  if (fetchError && httpStatus === 0) {
    status = 'error';
  } else if (httpStatus >= 400) {
    status = 'dead';
  } else if (detectPaywall(content)) {
    status = 'paywall';
  } else if (content.length > 0) {
    status = 'ok';
  } else if (fetchError) {
    status = 'error';
  } else {
    status = 'ok'; // PDF or non-HTML with 200 status
  }

  // ---- 5. Persist to SQLite (fast local cache) and PostgreSQL (durable source of truth) ----
  if (content.length > 0) {
    saveToDb(url, title, content, httpStatus);
    saveToPostgres(url, title, content, httpStatus);
  }

  // ---- 6. Extract excerpts ----
  const excerpts = extractMode === 'relevant' && query && content
    ? extractRelevantExcerpts(content, query)
    : [];

  // ---- 7. Use resource title as fallback ----
  const finalTitle = title || resource?.title || '';

  const result: FetchedSource = {
    url, title: finalTitle, fetchedAt: now, content, relevantExcerpts: excerpts,
    status, resource: resourceMeta,
  };

  // ---- 8. Store in session cache ----
  sessionCacheSet(url, result);

  // ---- 9. Reflect status back to resource YAML (if requested) ----

  if (request.updateResourceStatus && resource) {
    try {
      updateResourceFetchStatus(resource.id, {
        fetchStatus: status,
        fetchedAt: now,
        fetchedTitle: title || undefined,
      });
    } catch {
      // Best-effort — don't fail the fetch if YAML update fails
    }
  }

  return result;
}

/**
 * Fetch a URL, convert to clean text/markdown, and extract relevant excerpts.
 *
 * Caching layers:
 *   1. In-memory session cache (fastest, LRU-evicted at 500 entries)
 *   2. In-flight dedup (concurrent requests for same URL share one fetch)
 *   3. PostgreSQL (wiki-server) — durable cross-machine source of truth
 *   4. SQLite — fast local fallback (used when PostgreSQL is unavailable)
 *   5. Network fetch (Firecrawl preferred, built-in fallback)
 *
 * Writes: successful network fetches are stored in both SQLite (fast local cache)
 * and PostgreSQL (durable, fire-and-forget).
 */
export async function fetchSource(request: FetchRequest): Promise<FetchedSource> {
  const { extractMode, query } = request;

  // ---- 0. Resolve resource + URL ----
  const { url, resource } = resolveRequest(request);
  const resourceMeta = resource ? buildResourceMeta(resource) : undefined;

  // ---- 1. In-memory session cache ----
  const cached = sessionCache.get(url);
  if (cached) {
    const excerpts = extractMode === 'relevant' && query
      ? extractRelevantExcerpts(cached.content, query)
      : [];
    return { ...cached, relevantExcerpts: excerpts, resource: cached.resource ?? resourceMeta };
  }

  // ---- 2. In-flight deduplication (#650) ----
  // If another call is already fetching this URL, wait for it instead of
  // firing a duplicate network request.
  const inFlight = inFlightFetches.get(url);
  if (inFlight) {
    const result = await inFlight;
    const excerpts = extractMode === 'relevant' && query
      ? extractRelevantExcerpts(result.content, query)
      : [];
    return { ...result, relevantExcerpts: excerpts, resource: result.resource ?? resourceMeta };
  }

  // Register this fetch as in-flight, then execute.
  const fetchPromise = _fetchSourceCore(url, resource, resourceMeta, request)
    .finally(() => inFlightFetches.delete(url));
  inFlightFetches.set(url, fetchPromise);

  return fetchPromise;
}

/**
 * Fetch multiple URLs concurrently with a concurrency limit.
 * Results are returned in the same order as the input requests.
 */
export async function fetchSources(
  requests: FetchRequest[],
  opts: { concurrency?: number; delayMs?: number } = {},
): Promise<FetchedSource[]> {
  const concurrency = opts.concurrency ?? 5;
  const delayMs = opts.delayMs ?? 500;
  const results: FetchedSource[] = new Array(requests.length);

  for (let i = 0; i < requests.length; i += concurrency) {
    const batch = requests.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(r => fetchSource(r)));
    for (let j = 0; j < batchResults.length; j++) {
      results[i + j] = batchResults[j];
    }
    if (i + concurrency < requests.length && delayMs > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Integration helper for citations verify
// ---------------------------------------------------------------------------

/**
 * Fetch a citation URL and check if the content supports a given claim.
 *
 * Returns a FetchedSource with relevantExcerpts narrowed to the claim context.
 * Used by citations/verify-citations.ts to upgrade URL-alive checks to
 * content-presence checks.
 */
export async function fetchAndVerifyClaim(
  url: string,
  claimContext: string,
): Promise<{ source: FetchedSource; hasSupport: boolean }> {
  const source = await fetchSource({
    url,
    extractMode: 'relevant',
    query: claimContext,
  });

  const hasSupport = source.status === 'ok' && source.relevantExcerpts.length > 0;

  return { source, hasSupport };
}

/**
 * Build FetchRequest objects from a list of resource IDs.
 *
 * Convenience helper for callers who want to fetch by resource ID
 * rather than raw URLs. Invalid IDs (not found in resource YAML) are skipped.
 */
export function requestsFromResourceIds(
  resourceIds: string[],
  opts: { extractMode?: 'full' | 'relevant'; query?: string; updateResourceStatus?: boolean } = {},
): FetchRequest[] {
  return resourceIds
    .map(id => {
      const resource = getResourceById(id);
      if (!resource) return null;
      return {
        url: resource.url,
        resourceId: id,
        extractMode: opts.extractMode ?? 'full',
        query: opts.query,
        updateResourceStatus: opts.updateResourceStatus,
      } satisfies FetchRequest;
    })
    .filter((r): r is FetchRequest => r !== null);
}
