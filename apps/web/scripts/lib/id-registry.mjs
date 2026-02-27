/**
 * ID Registry Builder
 *
 * Builds the slug ↔ numericId bidirectional mapping from entities and pages.
 * Detects conflicts, assigns fallback IDs for local dev.
 *
 * Extracted from build-data.mjs for modularity.
 */

/**
 * Build initial ID registry from entities.
 * @param {Array<{id: string, numericId?: string}>} entities
 * @returns {{ slugToNumericId: Record<string, string>, numericIdToSlug: Record<string, string>, nextId: number }}
 */
export function buildIdRegistry(entities) {
  const slugToNumericId = {};
  const numericIdToSlug = {};
  const conflicts = [];

  for (const entity of entities) {
    if (entity.numericId) {
      if (numericIdToSlug[entity.numericId] && numericIdToSlug[entity.numericId] !== entity.id) {
        conflicts.push(`${entity.numericId} claimed by both "${numericIdToSlug[entity.numericId]}" and "${entity.id}"`);
      }
      numericIdToSlug[entity.numericId] = entity.id;
      slugToNumericId[entity.id] = entity.numericId;
    }
  }

  if (conflicts.length > 0) {
    console.error('\n  ERROR: numericId conflicts detected:');
    for (const c of conflicts) console.error(`    ${c}`);
    process.exit(1);
  }

  // Find next available ID
  let nextId = 1;
  for (const numId of Object.keys(numericIdToSlug)) {
    const n = parseInt(numId.slice(1));
    if (n >= nextId) nextId = n + 1;
  }

  // Assign fallback IDs to entities without one (local dev only)
  let newAssignments = 0;
  for (const entity of entities) {
    if (!entity.numericId) {
      const numId = `E${nextId}`;
      entity.numericId = numId;
      numericIdToSlug[numId] = entity.id;
      slugToNumericId[entity.id] = numId;
      nextId++;
      newAssignments++;
    }
  }

  if (newAssignments > 0) {
    console.log(`  idRegistry: assigned ${newAssignments} new IDs in-memory (run \`node scripts/assign-ids.mjs\` to persist)`);
  } else {
    console.log(`  idRegistry: all ${Object.keys(numericIdToSlug).length} entities have IDs`);
  }

  return { slugToNumericId, numericIdToSlug, nextId };
}

/**
 * Extend the ID registry with page-only numericIds (pages without YAML entities).
 * @param {object} opts
 * @param {Array<{id: string, numericId?: string, category?: string, contentFormat?: string}>} opts.pages
 * @param {Set<string>} opts.entityIds
 * @param {Record<string, string>} opts.slugToNumericId
 * @param {Record<string, string>} opts.numericIdToSlug
 * @param {Record<string, string>} opts.pathRegistry
 * @param {number} opts.nextId
 * @returns {{ nextId: number, pageIdAssignments: number }}
 */
export function extendIdRegistryWithPages({
  pages, entityIds, slugToNumericId, numericIdToSlug, pathRegistry, nextId,
}) {
  const skipCategories = new Set([
    'style-guides', 'tools', 'dashboard', 'project', 'guides',
  ]);

  const pageIdConflicts = [];

  // Pass 1: Collect existing page-level numericIds from frontmatter
  for (const page of pages) {
    if (page.numericId) {
      const existing = numericIdToSlug[page.numericId];
      if (existing && existing !== page.id) {
        const entityPath = pathRegistry[existing];
        if (entityPath && entityPath.endsWith(`/${page.id}/`)) {
          slugToNumericId[page.id] = page.numericId;
        } else {
          pageIdConflicts.push(`${page.numericId} claimed by entity "${existing}" and page "${page.id}"`);
        }
      } else {
        numericIdToSlug[page.numericId] = page.id;
      }
      slugToNumericId[page.id] = page.numericId;
    }
  }

  if (pageIdConflicts.length > 0) {
    console.error('\n  ERROR: numericId conflicts between entities and pages:');
    for (const c of pageIdConflicts) console.error(`    ${c}`);
    process.exit(1);
  }

  // Pass 2: Assign new numericIds in-memory to pages that don't have one yet
  let pageIdAssignments = 0;
  for (const page of pages) {
    if (entityIds.has(page.id)) continue;
    if (slugToNumericId[page.id]) continue;
    if (skipCategories.has(page.category)) continue;
    if (page.contentFormat === 'dashboard') continue;

    const numId = `E${nextId}`;
    numericIdToSlug[numId] = page.id;
    slugToNumericId[page.id] = numId;
    page.numericId = numId;
    nextId++;
    pageIdAssignments++;
  }

  if (pageIdAssignments > 0) {
    console.log(`  idRegistry: assigned ${pageIdAssignments} new page IDs in-memory (run \`node scripts/assign-ids.mjs\` to persist)`);
  }

  return { nextId, pageIdAssignments };
}
