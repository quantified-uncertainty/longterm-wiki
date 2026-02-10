/**
 * Server-side Search Utility
 *
 * Loads the pre-built MiniSearch index and provides a query interface
 * for CLI tooling and server-side operations.
 *
 * Usage:
 *   import { search } from './lib/search.mjs';
 *   const results = search('alignment tax');
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import MiniSearch from 'minisearch';

const APP_DATA_DIR = join(process.cwd(), 'app/src/data');

let _miniSearch = null;
let _docs = null;

/**
 * Load or return the cached MiniSearch instance and docs.
 */
function getSearchEngine() {
  if (_miniSearch && _docs) return { miniSearch: _miniSearch, docs: _docs };

  const indexPath = join(APP_DATA_DIR, 'search-index.json');
  const docsPath = join(APP_DATA_DIR, 'search-docs.json');

  if (!existsSync(indexPath) || !existsSync(docsPath)) {
    throw new Error(
      `Search index not found at ${indexPath}. Run "pnpm build" or "node app/scripts/build-data.mjs" first.`
    );
  }

  const indexText = readFileSync(indexPath, 'utf-8');
  const docsJSON = JSON.parse(readFileSync(docsPath, 'utf-8'));

  _miniSearch = MiniSearch.loadJSON(indexText, {
    fields: ['title', 'description', 'tags', 'entityType', 'id'],
  });

  _docs = new Map(docsJSON.map(d => [d.id, d]));

  return { miniSearch: _miniSearch, docs: _docs };
}

/**
 * Search the index and return enriched results.
 *
 * @param {string} query - Search query string
 * @param {object} [options] - MiniSearch search options override
 * @param {number} [limit=20] - Maximum results to return
 * @returns {Array<{ id: string, title: string, description: string, type: string, numericId: string, score: number }>}
 */
export function search(query, options = {}, limit = 20) {
  const { miniSearch, docs } = getSearchEngine();

  const raw = miniSearch.search(query, {
    boost: { title: 3.0, description: 2.0, tags: 1.5, entityType: 1.0, id: 1.0 },
    fuzzy: 0.2,
    prefix: true,
    ...options,
  });

  const q = query.trim().toLowerCase();

  // Re-rank: exact title match bonus + mild importance tiebreaker
  const scored = raw.map(hit => {
    const doc = docs.get(hit.id) || {};
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

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
