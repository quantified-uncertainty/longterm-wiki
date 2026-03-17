/**
 * ID Assignment Utilities — pure functions for wiki ID management
 *
 * Extracted from assign-ids.mjs so the core algorithms can be unit-tested
 * independently of filesystem I/O.
 *
 * Used by:
 *   - app/scripts/assign-ids.mjs (pre-build ID assignment step)
 *   - app/scripts/build-data.mjs (entity/page filtering)
 */

/**
 * Build wikiId↔slug lookup maps from an array of entities.
 *
 * Entities without a wikiId field are skipped — they will need IDs assigned.
 * Entities with the same wikiId as another entity are reported as conflicts.
 *
 * @param {Array<{id: string, wikiId?: string}>} entities
 * @returns {{ wikiIdToSlug: Object, slugToWikiId: Object, conflicts: string[] }}
 */
export function buildIdMaps(entities) {
  const wikiIdToSlug = {};
  const slugToWikiId = {};
  const conflicts = [];

  for (const entity of entities) {
    if (!entity.wikiId) continue;

    if (wikiIdToSlug[entity.wikiId] && wikiIdToSlug[entity.wikiId] !== entity.id) {
      conflicts.push(
        `${entity.wikiId} claimed by both "${wikiIdToSlug[entity.wikiId]}" and "${entity.id}"`
      );
    } else {
      wikiIdToSlug[entity.wikiId] = entity.id;
      slugToWikiId[entity.id] = entity.wikiId;
    }
  }

  return { wikiIdToSlug, slugToWikiId, conflicts };
}

/**
 * Filter a pages array to only those eligible for wiki ID assignment.
 *
 * A page is eligible if:
 *   - It does NOT already have an entity with the same ID (entityIds)
 *   - It is NOT in a skipped category (skipCategories)
 *   - Its contentFormat is not 'dashboard'
 *
 * This mirrors the filtering logic in both assign-ids.mjs and build-data.mjs.
 *
 * @param {Array<{id: string, category: string, contentFormat: string}>} pages
 * @param {Set<string>} entityIds  Set of entity IDs (page IDs matching these are skipped)
 * @param {Set<string>} skipCategories  Category names to skip
 * @returns {Array}  Filtered subset of pages
 */
export function filterEligiblePages(pages, entityIds, skipCategories) {
  return pages.filter(
    page =>
      !entityIds.has(page.id) &&
      !skipCategories.has(page.category) &&
      page.contentFormat !== 'dashboard'
  );
}
