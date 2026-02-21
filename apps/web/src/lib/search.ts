/**
 * Client-side Search
 *
 * Primary: server-side PostgreSQL full-text search via /api/search proxy.
 * Fallback: lazily-loaded MiniSearch index (for when the server is unreachable).
 *
 * The MiniSearch index (~685KB) is only fetched when a server request fails,
 * keeping the default bundle lean. Once loaded, MiniSearch stays cached for
 * the remainder of the session.
 */

import type MiniSearchType from "minisearch";

export interface SearchDoc {
  id: string;
  title: string;
  description: string;
  numericId: string;
  type: string;
  readerImportance: number | null;
  quality: number | null;
}

/** Which terms matched in which fields (from MiniSearch). */
export type MatchInfo = Record<string, string[]>;

export interface SearchResult extends SearchDoc {
  score: number;
  /** Maps each matched term → list of fields it matched in. */
  match: MatchInfo;
  /** The query terms that produced this result. */
  terms: string[];
}

// ---------------------------------------------------------------------------
// Server-side search
// ---------------------------------------------------------------------------

/** Whether we've confirmed the server is unavailable this session. */
let _serverUnavailable = false;

interface ServerSearchResponse {
  results: Array<{
    id: string;
    numericId: string | null;
    title: string;
    description: string | null;
    entityType: string | null;
    category: string | null;
    readerImportance: number | null;
    quality: number | null;
    score: number;
  }>;
  query: string;
  total: number;
}

/**
 * Search via the server-side PostgreSQL FTS proxy.
 * Returns null if the server is unavailable (triggers MiniSearch fallback).
 */
async function searchServer(
  query: string,
  limit: number,
): Promise<SearchResult[] | null> {
  if (_serverUnavailable) return null;

  try {
    const url = `/api/search?q=${encodeURIComponent(query)}&limit=${limit}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(4000),
    });

    if (!res.ok) {
      if (res.status === 503) _serverUnavailable = true;
      return null;
    }

    const data: ServerSearchResponse = await res.json();
    const queryTerms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

    return data.results.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description ?? "",
      numericId: r.numericId ?? r.id,
      type: r.entityType ?? "",
      readerImportance: r.readerImportance,
      quality: r.quality,
      score: r.score,
      // Server doesn't provide per-field match info; synthesize from query terms
      // so highlighting still works (terms are matched against description text)
      match: Object.fromEntries(
        queryTerms.map((t) => [t, ["title", "description"]]),
      ),
      terms: queryTerms,
    }));
  } catch {
    // Network error or timeout — mark server as unavailable for this session
    _serverUnavailable = true;
    return null;
  }
}

// ---------------------------------------------------------------------------
// MiniSearch fallback (lazy-loaded)
// ---------------------------------------------------------------------------

const SEARCH_FIELDS = [
  "title",
  "description",
  "llmSummary",
  "tags",
  "entityType",
  "id",
];
const FIELD_BOOSTS: Record<string, number> = {
  title: 3.0,
  description: 2.0,
  llmSummary: 1.5,
  tags: 1.5,
  entityType: 1.0,
  id: 1.0,
};

let _miniSearch: MiniSearchType | null = null;
let _docs: Map<string, SearchDoc> | null = null;
let _loadPromise: Promise<void> | null = null;

/**
 * Lazily load the MiniSearch index and docs from pre-built JSON files.
 * Only called when the server-side search is unavailable.
 */
async function ensureLoaded(): Promise<void> {
  if (_miniSearch && _docs) return;

  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    try {
      const [MiniSearch, indexRes, docsRes] = await Promise.all([
        import("minisearch").then((m) => m.default),
        fetch("/search-index.json"),
        fetch("/search-docs.json"),
      ]);

      if (!indexRes.ok || !docsRes.ok) {
        throw new Error("Failed to load search index");
      }

      const [indexText, docsJSON] = await Promise.all([
        indexRes.text(),
        docsRes.json() as Promise<SearchDoc[]>,
      ]);

      _miniSearch = MiniSearch.loadJSON(indexText, {
        fields: SEARCH_FIELDS,
      });

      _docs = new Map(docsJSON.map((d) => [d.id, d]));
    } catch (err) {
      // Reset so the next call retries instead of returning a stale rejected promise
      _loadPromise = null;
      throw err;
    }
  })();

  return _loadPromise;
}

/**
 * Search using the local MiniSearch index (fallback path).
 */
async function searchMiniSearch(
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  await ensureLoaded();

  if (!_miniSearch || !_docs || !query.trim()) return [];

  const raw = _miniSearch.search(query, {
    boost: FIELD_BOOSTS,
    fuzzy: 0.2,
    prefix: true,
  });

  const q = query.trim().toLowerCase();

  // Re-rank: exact title match bonus + mild importance tiebreaker
  const scored = raw.map((hit) => {
    const doc = _docs!.get(hit.id);
    const title = (doc?.title ?? "").toLowerCase();

    let boost = 1.0;
    if (title === q) boost *= 3.0;
    boost *= 1 + (doc?.readerImportance ?? 0) / 300;

    return {
      id: doc?.id ?? hit.id,
      title: doc?.title ?? hit.id,
      description: doc?.description ?? "",
      numericId: doc?.numericId ?? hit.id,
      type: doc?.type ?? "",
      readerImportance: doc?.readerImportance ?? null,
      quality: doc?.quality ?? null,
      score: hit.score * boost,
      match: (hit.match ?? {}) as MatchInfo,
      terms: hit.terms ?? [],
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search the wiki. Tries server-side PostgreSQL FTS first, falls back to
 * the local MiniSearch index if the server is unreachable.
 */
export async function searchWiki(
  query: string,
  limit = 20,
): Promise<SearchResult[]> {
  if (!query.trim()) return [];

  // Try server-side search first
  const serverResults = await searchServer(query, limit);
  if (serverResults !== null) return serverResults;

  // Fall back to local MiniSearch
  return searchMiniSearch(query, limit);
}

/**
 * Search returning a Map of id → score for all matching documents.
 * Used by the Explore page to filter and rank items via MiniSearch.
 *
 * Always uses MiniSearch since this needs scores for ALL matching docs
 * (not just top-N results), which is the local index's strength.
 */
export async function searchWikiScores(
  query: string,
): Promise<Map<string, number>> {
  await ensureLoaded();

  if (!_miniSearch || !_docs || !query.trim()) return new Map();

  const raw = _miniSearch.search(query, {
    boost: FIELD_BOOSTS,
    fuzzy: 0.2,
    prefix: true,
  });

  const q = query.trim().toLowerCase();
  const scores = new Map<string, number>();

  for (const hit of raw) {
    const doc = _docs.get(hit.id);
    const title = (doc?.title ?? "").toLowerCase();

    let boost = 1.0;
    if (title === q) boost *= 3.0;
    boost *= 1 + (doc?.readerImportance ?? 0) / 300;

    scores.set(hit.id, hit.score * boost);
  }

  return scores;
}

/**
 * Preload the MiniSearch index in the background.
 * Call this early (e.g., on hover over the search button) for instant
 * fallback if the server is unavailable.
 */
export function preloadSearchIndex(): void {
  ensureLoaded().catch(() => {
    // Silently fail — will retry on actual search
  });
}
