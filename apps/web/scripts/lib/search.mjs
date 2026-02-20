/**
 * Search Index Builder
 *
 * Builds a MiniSearch index at build time from typed entities and pages.
 * Produces two files:
 *   - search-index.json  — serialized MiniSearch index
 *   - search-docs.json   — minimal document metadata for rendering results
 */

import MiniSearch from 'minisearch';

/**
 * Fields indexed by MiniSearch.
 * Boost weights are configured at search time in the consumers
 * (apps/web/src/lib/search.ts), not here —
 * constructor-level searchOptions don't survive toJSON/loadJSON.
 */
const SEARCH_FIELDS = ['title', 'description', 'llmSummary', 'tags', 'entityType', 'id'];

/**
 * Build search documents from typed entities, pages, and the ID registry.
 *
 * @param {Array} typedEntities - Transformed entities from build-data
 * @param {Array} pages - Pages array from build-data
 * @param {Object} idRegistry - { bySlug: { slug: 'E42' }, byNumericId: { 'E42': slug } }
 * @returns {{ index: object, docs: Array }}
 */
export function buildSearchIndex(typedEntities, pages, idRegistry) {
  const pageMap = new Map(pages.map(p => [p.id, p]));
  const entityIds = new Set(typedEntities.map(e => e.id));

  const documents = [];

  // 1. Entities with pages — primary search targets
  for (const entity of typedEntities) {
    const page = pageMap.get(entity.id);
    if (!page) continue; // skip entities without content pages

    const numericId = entity.numericId || idRegistry?.bySlug?.[entity.id] || entity.id;

    documents.push({
      id: entity.id,
      title: entity.title,
      description: page.description || entity.description || '',
      llmSummary: page.llmSummary || '',
      tags: (entity.tags || []).join(' '),
      entityType: entity.entityType || '',
      contentFormat: page.contentFormat || 'article',
      // Metadata for result display (not indexed)
      _numericId: numericId,
      _type: entity.entityType || 'concept',
      _readerImportance: page.readerImportance,
      _quality: page.quality,
    });
  }

  // 2. Pages without entities
  for (const page of pages) {
    if (entityIds.has(page.id)) continue;
    if (!page.title || page.category === 'schema' || page.category === 'internal') continue;

    const numericId = idRegistry?.bySlug?.[page.id] || page.id;

    documents.push({
      id: page.id,
      title: page.title,
      description: page.description || '',
      llmSummary: page.llmSummary || '',
      tags: (page.tags || []).join(' '),
      entityType: page.category || '',
      contentFormat: page.contentFormat || 'article',
      _numericId: numericId,
      _type: page.category || 'concept',
      _readerImportance: page.readerImportance,
      _quality: page.quality,
    });
  }

  // 3. Build MiniSearch index
  const miniSearch = new MiniSearch({
    fields: SEARCH_FIELDS,
    storeFields: [], // We store docs separately for smaller index
  });

  miniSearch.addAll(documents);

  // 4. Build compact docs lookup (id → display info)
  // Use llmSummary for display when available — it's more informative than description.
  const docs = documents.map(d => ({
    id: d.id,
    title: d.title,
    description: truncate(d.llmSummary || d.description, 300),
    numericId: d._numericId,
    type: d._type,
    readerImportance: d._readerImportance,
    quality: d._quality,
    contentFormat: d.contentFormat,
  }));

  return {
    index: miniSearch.toJSON(),
    docs,
  };
}

/**
 * Truncate a string to a maximum length, appending ellipsis if truncated.
 */
function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str || '';
  return str.slice(0, maxLen - 1) + '\u2026';
}
