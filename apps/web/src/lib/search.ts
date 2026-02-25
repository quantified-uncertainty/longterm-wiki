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
  numericId: string;
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
    numericId: string | null;
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
        numericId: r.numericId ?? r.id,
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
// Public API
// ---------------------------------------------------------------------------

/**
 * Search the wiki via server-side PostgreSQL FTS.
 * Returns an empty array if the server is unreachable.
 */
export async function searchWiki(
  query: string,
  limit = 20,
): Promise<SearchResult[]> {
  if (!query.trim()) return [];

  const results = await searchServer(query, limit);
  return results ?? [];
}
