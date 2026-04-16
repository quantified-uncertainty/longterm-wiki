/**
 * ID Registry Builder
 *
 * Builds the slug ↔ wikiId ↔ stableId mappings from entities and pages.
 * Detects conflicts, assigns fallback IDs for local dev.
 *
 * Extracted from build-data.mjs for modularity.
 */

/**
 * Build initial ID registry from entities.
 *
 * Allocation precedence for each entity:
 *   1. entity.wikiId on the input row (already persisted to YAML/MDX/PG).
 *      Cross-checked against the persistent registry when one is supplied
 *      — a mismatch is a blocking conflict because the persistent registry
 *      is the authoritative source and a stale denormalized wikiId would
 *      otherwise silently win.
 *   2. persistedSlugToWikiId[slug] — the authoritative `entity_ids` PG table
 *      (see fetchPersistentIdRegistry in id-client.mjs). Pre-seeding from
 *      this map is what makes PG-sourced builds deterministic across runs —
 *      without it, fallback allocation in step 3 produces different
 *      E-numbers each run (QUA-521).
 *   3. In-memory fallback allocation from `nextId++`, in input iteration
 *      order. Local-dev only; CI/prod should never hit this path because
 *      assign-ids.mjs runs first and persists everything to the server.
 *      (Input order is preserved rather than sorted — the historical
 *      content in MDX files was authored against input-order fallback
 *      assignments, and reordering would renumber entities whose IDs are
 *      referenced from MDX.)
 *
 * @param {Array<{id: string, wikiId?: string, stableId?: string}>} entities
 * @param {Set<string>|Iterable<string>} [reservedWikiIds] — wikiIds claimed by pages
 * @param {{ persistedSlugToWikiId?: Map<string, string>|Record<string, string> }} [opts]
 * @returns {{ slugToWikiId: Record<string, string>, wikiIdToSlug: Record<string, string>, byStableId: Record<string, string>, stableIdBySlug: Record<string, string>, nextId: number }}
 */
export function buildIdRegistry(entities, reservedWikiIds = new Set(), opts = {}) {
  const slugToWikiId = {};
  const wikiIdToSlug = {};
  const byStableId = {};
  const stableIdBySlug = {};
  const conflicts = [];

  // Normalize persistedSlugToWikiId to a Map for consistent lookup.
  const persistedMap = opts.persistedSlugToWikiId
    ? (opts.persistedSlugToWikiId instanceof Map
        ? opts.persistedSlugToWikiId
        : new Map(Object.entries(opts.persistedSlugToWikiId)))
    : new Map();

  for (const entity of entities) {
    if (entity.wikiId) {
      if (wikiIdToSlug[entity.wikiId] && wikiIdToSlug[entity.wikiId] !== entity.id) {
        conflicts.push(`${entity.wikiId} claimed by both "${wikiIdToSlug[entity.wikiId]}" and "${entity.id}"`);
      }
      wikiIdToSlug[entity.wikiId] = entity.id;
      slugToWikiId[entity.id] = entity.wikiId;
    }
    // Build stableId ↔ slug mappings
    if (entity.stableId) {
      if (byStableId[entity.stableId] && byStableId[entity.stableId] !== entity.id) {
        conflicts.push(`stableId ${entity.stableId} claimed by both "${byStableId[entity.stableId]}" and "${entity.id}"`);
      }
      byStableId[entity.stableId] = entity.id;
      stableIdBySlug[entity.id] = entity.stableId;
    }
  }

  if (conflicts.length > 0) {
    console.error('\n  ERROR: wikiId conflicts detected:');
    for (const c of conflicts) console.error(`    ${c}`);
    process.exit(1);
  }

  // Step 2: pre-seed from the persistent id_registry (entity_ids PG table).
  // This is the fix for QUA-521 — without pre-seeding, step 3 allocates
  // different fallback IDs on each run and PG-sourced builds diverge.
  //
  // We ALSO consult the persistent registry for entities that already have
  // a denormalized `wikiId` on the input row. A stale denormalized value
  // could silently win over the authoritative entity_ids mapping — exactly
  // the kind of drift this pipeline is trying to surface. Any mismatch is
  // a blocking conflict (the persistent registry is authoritative).
  let persistedAssignments = 0;
  const persistedConflicts = [];
  for (const entity of entities) {
    const persisted = persistedMap.get(entity.id);
    if (!persisted) continue;
    if (entity.wikiId && entity.wikiId !== persisted) {
      persistedConflicts.push(
        `"${entity.id}" has input wikiId ${entity.wikiId} but persisted registry says ${persisted}`
      );
      continue;
    }
    if (entity.wikiId) continue; // already matches persisted — nothing to do
    if (wikiIdToSlug[persisted] && wikiIdToSlug[persisted] !== entity.id) {
      persistedConflicts.push(`${persisted} (persisted registry) claimed by "${wikiIdToSlug[persisted]}" and "${entity.id}"`);
      continue;
    }
    entity.wikiId = persisted;
    wikiIdToSlug[persisted] = entity.id;
    slugToWikiId[entity.id] = persisted;
    persistedAssignments++;
  }
  if (persistedConflicts.length > 0) {
    console.error('\n  ERROR: wikiId conflicts between input and persisted id_registry:');
    for (const c of persistedConflicts) console.error(`    ${c}`);
    process.exit(1);
  }

  // Find next available ID
  let nextId = 1;
  for (const numId of Object.keys(wikiIdToSlug)) {
    const n = parseInt(numId.slice(1));
    if (n >= nextId) nextId = n + 1;
  }

  // Step 3: assign fallback IDs to entities still without one (local dev only).
  //
  // Iterate in input order (not sorted) to preserve backward compatibility
  // with historical content references. MDX pages reference specific
  // E-numbers like `<EntityLink id="E2886" name="baidu">` that were
  // minted by input-order fallback; renumbering via sort would break those
  // references for every entity that lacks a persisted wikiId. Deterministic
  // cross-pipeline IDs are achieved via the persistent-registry pre-seed
  // above (step 2), which is the real fix for QUA-521. The `reservedWikiIds`
  // loop below still guarantees we skip wikiIds already claimed by pages.
  let newAssignments = 0;
  for (const entity of entities) {
    if (entity.wikiId) continue;
    while (reservedWikiIds.has(`E${nextId}`)) {
      nextId++;
    }
    const numId = `E${nextId}`;
    entity.wikiId = numId;
    wikiIdToSlug[numId] = entity.id;
    slugToWikiId[entity.id] = numId;
    nextId++;
    newAssignments++;
  }

  if (persistedAssignments > 0) {
    console.log(`  idRegistry: recovered ${persistedAssignments} wikiIds from persistent registry (entity_ids)`);
  }
  if (newAssignments > 0) {
    console.log(`  idRegistry: assigned ${newAssignments} new IDs in-memory (run \`node scripts/assign-ids.mjs\` to persist)`);
  } else if (persistedAssignments === 0) {
    console.log(`  idRegistry: all ${Object.keys(wikiIdToSlug).length} entities have IDs`);
  }

  return { slugToWikiId, wikiIdToSlug, byStableId, stableIdBySlug, nextId };
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
  persistedSlugToWikiId,
}) {
  const persistedMap = persistedSlugToWikiId
    ? (persistedSlugToWikiId instanceof Map
        ? persistedSlugToWikiId
        : new Map(Object.entries(persistedSlugToWikiId)))
    : new Map();
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

  // Pass 2a: recover wikiIds from the persistent registry for pages
  // without one. See QUA-521 — ensures PG-sourced builds are deterministic.
  let persistedPageAssignments = 0;
  for (const page of pages) {
    if (entityIds.has(page.id)) continue;
    if (slugToWikiId[page.id]) continue;
    if (skipCategories.has(page.category)) continue;
    if (page.contentFormat === 'dashboard') continue;
    const persisted = persistedMap.get(page.id);
    if (!persisted) continue;
    if (wikiIdToSlug[persisted] && wikiIdToSlug[persisted] !== page.id) continue;
    wikiIdToSlug[persisted] = page.id;
    slugToWikiId[page.id] = persisted;
    page.wikiId = persisted;
    persistedPageAssignments++;
  }

  // Pass 2b: assign fallback wikiIds in input order.
  // (Input-order matches historical behavior; MDX-referenced E-numbers
  // were minted this way. The persistent-registry pre-seed in pass 2a is
  // the deterministic-across-pipelines fix; this pass is a local-dev
  // fallback only.) Before each assignment, advance `nextId` past any
  // wikiId already claimed in `wikiIdToSlug` (by earlier entities, by
  // page frontmatter in pass 1, or by the persistent pre-seed in 2a) —
  // without this, a collision could double-assign an E-number.
  const pagesNeedingIds = pages.filter((page) =>
    !entityIds.has(page.id)
    && !slugToWikiId[page.id]
    && !skipCategories.has(page.category)
    && page.contentFormat !== 'dashboard'
  );

  let pageIdAssignments = 0;
  for (const page of pagesNeedingIds) {
    while (wikiIdToSlug[`E${nextId}`]) {
      nextId++;
    }
    const numId = `E${nextId}`;
    wikiIdToSlug[numId] = page.id;
    slugToWikiId[page.id] = numId;
    page.wikiId = numId;
    nextId++;
    pageIdAssignments++;
  }

  if (persistedPageAssignments > 0) {
    console.log(`  idRegistry: recovered ${persistedPageAssignments} page wikiIds from persistent registry (entity_ids)`);
  }

  if (pageIdAssignments > 0) {
    console.log(`  idRegistry: assigned ${pageIdAssignments} new page IDs in-memory (run \`node scripts/assign-ids.mjs\` to persist)`);
  }

  return { nextId, pageIdAssignments };
}
