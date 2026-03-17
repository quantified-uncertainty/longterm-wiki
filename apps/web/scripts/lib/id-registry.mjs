/**
 * ID Registry Builder
 *
 * Builds the slug ↔ wikiId bidirectional mapping from entities and pages.
 * Detects conflicts, assigns fallback IDs for local dev.
 *
 * Extracted from build-data.mjs for modularity.
 */

/**
 * Build initial ID registry from entities.
 * @param {Array<{id: string, wikiId?: string}>} entities
 * @returns {{ slugToWikiId: Record<string, string>, wikiIdToSlug: Record<string, string>, nextId: number }}
 */
export function buildIdRegistry(entities) {
  const slugToWikiId = {};
  const wikiIdToSlug = {};
  const conflicts = [];

  for (const entity of entities) {
    if (entity.wikiId) {
      if (wikiIdToSlug[entity.wikiId] && wikiIdToSlug[entity.wikiId] !== entity.id) {
        conflicts.push(`${entity.wikiId} claimed by both "${wikiIdToSlug[entity.wikiId]}" and "${entity.id}"`);
      }
      wikiIdToSlug[entity.wikiId] = entity.id;
      slugToWikiId[entity.id] = entity.wikiId;
    }
  }

  if (conflicts.length > 0) {
    console.error('\n  ERROR: wikiId conflicts detected:');
    for (const c of conflicts) console.error(`    ${c}`);
    process.exit(1);
  }

  // Find next available ID
  let nextId = 1;
  for (const numId of Object.keys(wikiIdToSlug)) {
    const n = parseInt(numId.slice(1));
    if (n >= nextId) nextId = n + 1;
  }

  // Assign fallback IDs to entities without one (local dev only)
  let newAssignments = 0;
  for (const entity of entities) {
    if (!entity.wikiId) {
      const numId = `E${nextId}`;
      entity.wikiId = numId;
      wikiIdToSlug[numId] = entity.id;
      slugToWikiId[entity.id] = numId;
      nextId++;
      newAssignments++;
    }
  }

  if (newAssignments > 0) {
    console.log(`  idRegistry: assigned ${newAssignments} new IDs in-memory (run \`node scripts/assign-ids.mjs\` to persist)`);
  } else {
    console.log(`  idRegistry: all ${Object.keys(wikiIdToSlug).length} entities have IDs`);
  }

  return { slugToWikiId, wikiIdToSlug, nextId };
}

/**
 * Extend the ID registry with page-only wikiIds (pages without YAML entities).
 * @param {object} opts
 * @param {Array<{id: string, wikiId?: string, category?: string, contentFormat?: string}>} opts.pages
 * @param {Set<string>} opts.entityIds
 * @param {Record<string, string>} opts.slugToWikiId
 * @param {Record<string, string>} opts.wikiIdToSlug
 * @param {Record<string, string>} opts.pathRegistry
 * @param {number} opts.nextId
 * @returns {{ nextId: number, pageIdAssignments: number }}
 */
export function extendIdRegistryWithPages({
  pages, entityIds, slugToWikiId, wikiIdToSlug, pathRegistry, nextId,
}) {
  const skipCategories = new Set([
    'style-guides', 'tools', 'dashboard', 'project', 'guides',
  ]);

  const pageIdConflicts = [];

  // Pass 1: Collect existing page-level wikiIds from frontmatter
  for (const page of pages) {
    if (page.wikiId) {
      const existing = wikiIdToSlug[page.wikiId];
      if (existing && existing !== page.id) {
        const entityPath = pathRegistry[existing];
        if (entityPath && entityPath.endsWith(`/${page.id}/`)) {
          slugToWikiId[page.id] = page.wikiId;
        } else {
          pageIdConflicts.push(`${page.wikiId} claimed by entity "${existing}" and page "${page.id}"`);
        }
      } else {
        wikiIdToSlug[page.wikiId] = page.id;
      }
      slugToWikiId[page.id] = page.wikiId;
    }
  }

  if (pageIdConflicts.length > 0) {
    console.error('\n  ERROR: wikiId conflicts between entities and pages:');
    for (const c of pageIdConflicts) console.error(`    ${c}`);
    process.exit(1);
  }

  // Pass 2: Assign new wikiIds in-memory to pages that don't have one yet
  let pageIdAssignments = 0;
  for (const page of pages) {
    if (entityIds.has(page.id)) continue;
    if (slugToWikiId[page.id]) continue;
    if (skipCategories.has(page.category)) continue;
    if (page.contentFormat === 'dashboard') continue;

    const numId = `E${nextId}`;
    wikiIdToSlug[numId] = page.id;
    slugToWikiId[page.id] = numId;
    page.wikiId = numId;
    nextId++;
    pageIdAssignments++;
  }

  if (pageIdAssignments > 0) {
    console.log(`  idRegistry: assigned ${pageIdAssignments} new page IDs in-memory (run \`node scripts/assign-ids.mjs\` to persist)`);
  }

  return { nextId, pageIdAssignments };
}
