/**
 * Client-side Search
 *
 * Lazily loads the pre-built MiniSearch index and document metadata,
 * then exposes a search function for the SearchDialog component.
 */

import MiniSearch from "minisearch";

export interface SearchDoc {
  id: string;
  title: string;
  description: string;
  numericId: string;
  type: string;
  importance: number | null;
  quality: number | null;
}

export interface SearchResult extends SearchDoc {
  score: number;
}

const SEARCH_FIELDS = ["title", "description", "tags", "entityType", "id"];
const FIELD_BOOSTS: Record<string, number> = {
  title: 3.0,
  description: 2.0,
  tags: 1.5,
  entityType: 1.0,
  id: 1.0,
};

let _miniSearch: MiniSearch | null = null;
let _docs: Map<string, SearchDoc> | null = null;
let _loadPromise: Promise<void> | null = null;

/**
 * Lazily load the search index and docs from pre-built JSON files.
 * The JSON files are placed in public/ at build time via next.config.
 * We fetch them at runtime so they're not included in the JS bundle.
 */
async function ensureLoaded(): Promise<void> {
  if (_miniSearch && _docs) return;

  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    try {
      const [indexRes, docsRes] = await Promise.all([
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
 * Search the index. Returns up to `limit` results.
 * Automatically loads the index on first call.
 */
export async function searchWiki(
  query: string,
  limit = 20
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
    // Exact title match — strongest signal that this is THE page
    if (title === q) boost *= 3.0;
    // Mild importance tiebreaker (0–33% boost)
    boost *= 1 + (doc?.importance ?? 0) / 300;

    return {
      id: doc?.id ?? hit.id,
      title: doc?.title ?? hit.id,
      description: doc?.description ?? "",
      numericId: doc?.numericId ?? hit.id,
      type: doc?.type ?? "",
      importance: doc?.importance ?? null,
      quality: doc?.quality ?? null,
      score: hit.score * boost,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Preload the search index in the background.
 * Call this early (e.g., on hover over the search button) for instant results.
 */
export function preloadSearchIndex(): void {
  ensureLoaded().catch(() => {
    // Silently fail — will retry on actual search
  });
}
