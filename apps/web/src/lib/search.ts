/**
 * Client-side Search
 *
 * Uses server-side PostgreSQL full-text search via /api/search proxy.
 * If the server is unreachable, returns an empty result set with an error flag.
 */

export interface SearchDoc {
  id: string;
  title: string;
  description: string;
  wikiId: string;
  type: string;
  readerImportance: number | null;
  quality: number | null;
}

/** Which terms matched in which fields. */
export type MatchInfo = Record<string, string[]>;

export interface SearchResult extends SearchDoc {
  score: number;
  /** Maps each matched term → list of fields it matched in. */
  match: MatchInfo;
  /** The query terms that produced this result. */
  terms: string[];
  /** Server-generated HTML snippet with <mark> tags from ts_headline(). */
  snippet?: string;
}

// ---------------------------------------------------------------------------
// Server-side search
// ---------------------------------------------------------------------------

interface ServerSearchResponse {
  results: Array<{
    id: string;
    wikiId: string | null;
    title: string;
    description: string | null;
    entityType: string | null;
    category: string | null;
    readerImportance: number | null;
    quality: number | null;
    score: number;
    snippet: string | null;
  }>;
  query: string;
  total: number;
}

/**
 * Search via the server-side PostgreSQL FTS proxy.
 * Returns null if the server is unavailable.
 */
async function searchServer(
  query: string,
  limit: number,
): Promise<SearchResult[] | null> {
  try {
    const url = `/api/search?q=${encodeURIComponent(query)}&limit=${limit}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(4000),
    });

    if (!res.ok) return null;

    const data: ServerSearchResponse = await res.json();

    const queryTerms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

    return data.results.map((r) => {
      const titleLower = r.title?.toLowerCase() ?? "";
      const descLower = (r.description ?? "").toLowerCase();

      return {
        id: r.id,
        title: r.title,
        description: r.description ?? "",
        wikiId: r.wikiId ?? r.id,
        type: r.entityType ?? "",
        readerImportance: r.readerImportance,
        quality: r.quality,
        score: r.score,
        snippet: r.snippet || undefined,
        // Synthesize per-field match info from query terms for highlighting
        match: Object.fromEntries(
          queryTerms.map((t) => {
            const fields: string[] = [];
            if (titleLower.includes(t)) fields.push("title");
            if (descLower.includes(t)) fields.push("description");
            return [t, fields.length > 0 ? fields : ["title", "description"]];
          }),
        ),
        terms: queryTerms,
      };
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Things search (grants, funding-rounds, benchmarks, etc.)
// ---------------------------------------------------------------------------

export interface ThingSearchResult {
  id: string;
  thingType: string;
  title: string;
  description: string | null;
  parentTitle: string | null;
  parentThingId: string | null;
  sourceTable: string;
  sourceId: string;
  entityType: string | null;
  sourceUrl: string | null;
  wikiId: string | null;
  href: string | null;
  verdict: string | null;
  verdictConfidence: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface ThingsSearchResponse {
  results: Array<ThingSearchResult>;
  query: string;
  total: number;
  searchMethod: "fts" | "ilike" | "none";
}

/**
 * Search the things table via server-side PostgreSQL FTS.
 * Returns null if the server is unavailable.
 */
async function searchThingsServer(
  query: string,
  limit: number,
  thingType?: string,
): Promise<ThingSearchResult[] | null> {
  try {
    const params = new URLSearchParams({
      q: query,
      limit: String(limit),
    });
    if (thingType) params.set("thing_type", thingType);

    const url = `/api/things-search?${params}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(3500),
    });

    if (!res.ok) return null;

    const data: ThingsSearchResponse = await res.json();
    return data.results;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Query normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a search query for better FTS matching.
 * Inserts spaces at letter/digit boundaries so concatenated terms like
 * "sb1047" become "sb 1047", matching how titles are tokenized.
 * Returns null if the query is already normalized.
 */
function normalizeQuery(query: string): string | null {
  // Insert space between letter→digit and digit→letter transitions
  const normalized = query.replace(/([a-zA-Z])(\d)/g, "$1 $2").replace(/(\d)([a-zA-Z])/g, "$1 $2");
  return normalized !== query ? normalized : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search the wiki via server-side PostgreSQL FTS.
 * Returns an empty array if the server is unreachable.
 * Automatically tries a normalized query (splitting letter/digit boundaries)
 * if the original query returns few results.
 */
export async function searchWiki(
  query: string,
  limit = 20,
): Promise<SearchResult[]> {
  if (!query.trim()) return [];

  const results = await searchServer(query, limit);
  const items = results ?? [];

  // If few results, also try with normalized query and merge
  if (items.length < 5) {
    const normalized = normalizeQuery(query);
    if (normalized) {
      const extra = await searchServer(normalized, limit);
      if (extra) {
        const seen = new Set(items.map((r) => r.id));
        for (const r of extra) {
          if (!seen.has(r.id)) {
            items.push(r);
            seen.add(r.id);
          }
        }
      }
    }
  }

  return items;
}

/**
 * Search the things table (grants, funding-rounds, benchmarks, etc.).
 * Returns an empty array if the server is unreachable.
 * Also tries normalized query for concatenated terms.
 */
export async function searchThings(
  query: string,
  limit = 20,
  thingType?: string,
): Promise<ThingSearchResult[]> {
  if (!query.trim()) return [];

  const results = await searchThingsServer(query, limit, thingType);
  const items = results ?? [];

  // Also try normalized query for concatenated terms like "sb1047"
  if (items.length < 5) {
    const normalized = normalizeQuery(query);
    if (normalized) {
      const extra = await searchThingsServer(normalized, limit, thingType);
      if (extra) {
        const seen = new Set(items.map((r) => r.id));
        for (const r of extra) {
          if (!seen.has(r.id)) {
            items.push(r);
            seen.add(r.id);
          }
        }
      }
    }
  }

  return items;
}
