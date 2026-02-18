/**
 * ID Assignment Utilities — pure functions for numeric ID management
 *
 * Extracted from assign-ids.mjs so the core algorithms can be unit-tested
 * independently of filesystem I/O.
 *
 * Used by:
 *   - app/scripts/assign-ids.mjs (pre-build ID assignment step)
 *   - app/scripts/build-data.mjs (in-memory fallback assignment)
 */

/**
 * Build numericId↔slug lookup maps from an array of entities.
 *
 * Entities without a numericId field are skipped — they will need IDs assigned.
 * Entities with the same numericId as another entity are reported as conflicts.
 *
 * @param {Array<{id: string, numericId?: string}>} entities
 * @returns {{ numericIdToSlug: Object, slugToNumericId: Object, conflicts: string[] }}
 */
export function buildIdMaps(entities) {
  const numericIdToSlug = {};
  const slugToNumericId = {};
  const conflicts = [];

  for (const entity of entities) {
    if (!entity.numericId) continue;

    if (numericIdToSlug[entity.numericId] && numericIdToSlug[entity.numericId] !== entity.id) {
      conflicts.push(
        `${entity.numericId} claimed by both "${numericIdToSlug[entity.numericId]}" and "${entity.id}"`
      );
    } else {
      numericIdToSlug[entity.numericId] = entity.id;
      slugToNumericId[entity.id] = entity.numericId;
    }
  }

  return { numericIdToSlug, slugToNumericId, conflicts };
}

/**
 * Compute the next available numeric ID (as an integer) from existing maps.
 *
 * Scans all current assignments (numericIdToSlug keys) and any additional
 * reserved IDs to find the smallest unused integer above all current ones.
 *
 * @param {Object} numericIdToSlug  Current mapping: "E123" → slug
 * @param {Iterable<string>} [additionalReserved=[]]  Extra "E###" IDs to reserve
 * @returns {number}  Next integer N such that "E{N}" is available
 */
export function computeNextId(numericIdToSlug, additionalReserved = []) {
  let nextId = 1;

  for (const numId of Object.keys(numericIdToSlug)) {
    const n = parseInt(numId.slice(1), 10);
    if (!isNaN(n) && n >= nextId) nextId = n + 1;
  }

  for (const numId of additionalReserved) {
    const n = parseInt(numId.slice(1), 10);
    if (!isNaN(n) && n >= nextId) nextId = n + 1;
  }

  return nextId;
}

/**
 * Filter a pages array to only those eligible for numeric ID assignment.
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
