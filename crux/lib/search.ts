/**
 * Server-side Search Utility
 *
 * Loads the pre-built MiniSearch index and provides a query interface
 * for CLI tooling and server-side operations.
 *
 * Usage:
 *   import { search } from './lib/search.ts';
 *   const results = search('alignment tax');
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import MiniSearch from 'minisearch';

const APP_DATA_DIR = join(process.cwd(), 'app/src/data');

export interface SearchResult {
  id: string;
  title: string;
  description: string;
  type: string;
  numericId: string;
  score: number;
}

interface SearchDoc {
  id: string;
  title?: string;
  description?: string;
  type?: string;
  numericId?: string;
  importance?: number;
}

let _miniSearch: MiniSearch | null = null;
let _docs: Map<string, SearchDoc> | null = null;

/**
 * Load or return the cached MiniSearch instance and docs.
 */
function getSearchEngine(): { miniSearch: MiniSearch; docs: Map<string, SearchDoc> } {
  if (_miniSearch && _docs) return { miniSearch: _miniSearch, docs: _docs };

  const indexPath = join(APP_DATA_DIR, 'search-index.json');
  const docsPath = join(APP_DATA_DIR, 'search-docs.json');

  if (!existsSync(indexPath) || !existsSync(docsPath)) {
    throw new Error(
      `Search index not found at ${indexPath}. Run "pnpm build" or "node app/scripts/build-data.mjs" first.`
    );
  }

  const indexText = readFileSync(indexPath, 'utf-8');
  const docsJSON: SearchDoc[] = JSON.parse(readFileSync(docsPath, 'utf-8'));

  _miniSearch = MiniSearch.loadJSON(indexText, {
    fields: ['title', 'description', 'tags', 'entityType', 'id'],
  });

  _docs = new Map(docsJSON.map(d => [d.id, d]));

  return { miniSearch: _miniSearch, docs: _docs };
}

/**
 * Search the index and return enriched results.
 */
export function search(query: string, options: Record<string, unknown> = {}, limit: number = 20): SearchResult[] {
  const { miniSearch, docs } = getSearchEngine();

  const raw = miniSearch.search(query, {
    boost: { title: 3.0, description: 2.0, tags: 1.5, entityType: 1.0, id: 1.0 },
    fuzzy: 0.2,
    prefix: true,
    ...options,
  });

  const q = query.trim().toLowerCase();

  // Re-rank: exact title match bonus + mild importance tiebreaker
  const scored = raw.map((hit: { id: string; score: number }) => {
    const doc = docs.get(hit.id) || {} as SearchDoc;
    const title = (doc.title || '').toLowerCase();

    let boost = 1.0;
    if (title === q) boost *= 3.0;
    boost *= 1 + (doc.importance || 0) / 300;

    return {
      id: hit.id,
      title: doc.title || hit.id,
      description: doc.description || '',
      type: doc.type || '',
      numericId: doc.numericId || hit.id,
      score: hit.score * boost,
    };
  });

  scored.sort((a: SearchResult, b: SearchResult) => b.score - a.score);
  return scored.slice(0, limit);
}
