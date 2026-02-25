/**
 * assign-ids.mjs — Pre-build ID assignment step
 *
 * Scans source files (YAML entities + MDX frontmatter) for entities and pages
 * without numericIds, assigns new IDs via the wiki server, and writes them
 * back to source files.
 *
 * This runs as a dedicated pre-build step before build-data.mjs, ensuring:
 *   1. All source file mutations complete before the main build starts
 *   2. If this step fails midway, re-running it is safe (idempotent)
 *   3. The main build (build-data.mjs) is purely read-only w.r.t. source files
 *
 * Requires the wiki server to be running (LONGTERMWIKI_SERVER_URL).
 *
 * Usage:
 *   node scripts/assign-ids.mjs [--dry-run]
 *
 * Resolves: https://github.com/quantified-uncertainty/longterm-wiki/issues/245
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { parse } from 'yaml';
import { CONTENT_DIR, DATA_DIR, TOP_LEVEL_CONTENT_DIRS, REPO_ROOT } from './lib/content-types.mjs';
import { scanFrontmatterEntities } from './lib/frontmatter-scanner.mjs';
import { buildIdMaps, filterEligiblePages } from './lib/id-assignment.mjs';
import { isServerAvailable, allocateIds, fetchServerEntityIdMap } from './lib/id-client.mjs';

// ---------------------------------------------------------------------------
// .env loading — must run before any process.env access
// ---------------------------------------------------------------------------
// Load .env from repo root so `node scripts/assign-ids.mjs` works without
// pre-setting LONGTERMWIKI_SERVER_URL / LONGTERMWIKI_SERVER_API_KEY in the
// shell.  dotenv.config() is a no-op when the file is absent or vars are
// already set, so this is safe to call unconditionally.
try {
  const { config } = await import('dotenv');
  config({ path: join(REPO_ROOT, '.env') });
} catch {
  // dotenv not available or .env missing — rely on shell environment
}

const DRY_RUN = process.argv.includes('--dry-run');
const SKIP = process.argv.includes('--skip');

// Categories to skip when assigning page IDs (mirrors build-data.mjs)
const SKIP_CATEGORIES = new Set([
  'style-guides', 'tools',
  'dashboard', 'project', 'guides',
]);

// ============================================================================
// Helpers
// ============================================================================

function extractFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  try {
    return parse(match[1]) || {};
  } catch {
    return {};
  }
}

/**
 * Load all YAML entities (id + numericId only) from data/entities/.
 * Returns array of { id, numericId? }.
 */
function loadYamlEntityIds() {
  const entityDir = join(DATA_DIR, 'entities');
  if (!existsSync(entityDir)) return [];
  const results = [];
  for (const file of readdirSync(entityDir)) {
    if (!file.endsWith('.yaml')) continue;
    try {
      const content = readFileSync(join(entityDir, file), 'utf-8');
      const entities = parse(content) || [];
      if (Array.isArray(entities)) {
        for (const e of entities) {
          if (e?.id) {
            results.push({
              id: e.id,
              numericId: e.numericId || null,
              _source: 'yaml',
            });
          }
        }
      }
    } catch (err) {
      console.error(`  ERROR reading ${file}: ${err.message}`);
    }
  }
  return results;
}

/**
 * Scan MDX content directories for pages needing IDs.
 * Returns array of { id, numericId?, category, contentFormat, _fullPath }.
 * Mirrors the page-scanning logic in build-data.mjs.
 */
function scanPages() {
  const pages = [];

  function scanDirectory(dir, urlPrefix) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        scanDirectory(fullPath, `${urlPrefix}/${entry}`);
      } else if (entry.endsWith('.mdx') || entry.endsWith('.md')) {
        const rawId = basename(entry, entry.endsWith('.mdx') ? '.mdx' : '.md');
        const isIndexFile = rawId === 'index';
        // Index files use a composite key (same as build-data.mjs)
        const id = isIndexFile ? `__index__${urlPrefix}` : rawId;
        const content = readFileSync(fullPath, 'utf-8');
        const fm = extractFrontmatter(content);
        pages.push({
          id,
          numericId: fm.numericId || null,
          _fullPath: fullPath,
          contentFormat: fm.contentFormat || 'article',
          // Mirrors build-data.mjs: prefer subdirectory, fall back to top-level dir
          category: urlPrefix.split('/').filter(Boolean)[1] || urlPrefix.split('/').filter(Boolean)[0] || 'other',
        });
      }
    }
  }

  scanDirectory(join(CONTENT_DIR, 'knowledge-base'), '/knowledge-base');
  for (const topDir of TOP_LEVEL_CONTENT_DIRS) {
    const dirPath = join(CONTENT_DIR, topDir);
    if (existsSync(dirPath)) {
      scanDirectory(dirPath, `/${topDir}`);
    }
  }

  return pages;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  if (SKIP) {
    console.log('  assign-ids: skipped (--skip flag)');
    return;
  }

  if (DRY_RUN) {
    console.log('[dry-run] Checking which IDs would be assigned (no files written)\n');
  }

  // Check server availability upfront, but don't fail yet —
  // only fail if we actually need to allocate new IDs.
  const serverAvailable = await isServerAvailable();
  if (serverAvailable) {
    console.log(`  Using wiki server at ${process.env.LONGTERMWIKI_SERVER_URL}`);
  } else if (DRY_RUN) {
    console.log('  Wiki server unavailable — dry-run will show entities needing IDs but cannot preview assignments');
  } else {
    console.log('  Wiki server not available — will skip if no new IDs are needed');
  }

  // -------------------------------------------------------------------------
  // Collect existing numericIds from YAML entities + frontmatter entities
  // -------------------------------------------------------------------------
  const yamlEntityItems = loadYamlEntityIds();
  const yamlEntityIds = new Set(yamlEntityItems.map(e => e.id));
  const frontmatterEntities = scanFrontmatterEntities(yamlEntityIds, CONTENT_DIR);
  const entities = [...yamlEntityItems, ...frontmatterEntities];

  const { numericIdToSlug, slugToNumericId, conflicts } = buildIdMaps(entities);

  if (conflicts.length > 0) {
    console.error('\n  ERROR: numericId conflicts detected:');
    for (const c of conflicts) console.error(`    ${c}`);
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // Verify manually-set numericIds for YAML entities against the server.
  //
  // YAML entity numericIds cannot be written back by assign-ids (we have no
  // safe way to round-trip YAML), so they must be added manually.  When
  // someone manually writes a numericId in a YAML file there is a risk of
  // bypassing the server-based ID allocation — e.g. writing a numericId
  // that the server has already allocated to a different slug.
  //
  // This step verifies every manually-set YAML entity numericId by asking the
  // server what ID it allocated for that slug.  The allocate endpoint is
  // idempotent: if the server has already registered the slug (e.g. from a
  // previous run), it returns the same ID with created=false; if not, it
  // creates a new one.  If the server-allocated ID differs from the local
  // manual value, we report a clear error.
  //
  // When the server is unavailable we skip verification and warn — this keeps
  // the offline/CI-without-server workflow working.
  // -------------------------------------------------------------------------
  const yamlEntitiesWithManualIds = yamlEntityItems.filter(e => e.numericId);

  if (yamlEntitiesWithManualIds.length > 0 && serverAvailable && !DRY_RUN) {
    // Verify manually-set numericIds against the server using a bulk read-only
    // lookup (no side effects — uses GET /api/entities, not the allocate endpoint).
    // We fetch all server-registered entities once and compare in-memory.
    console.log(`  Verifying ${yamlEntitiesWithManualIds.length} manually-set YAML entity numericIds against server...`);
    const serverIdMap = await fetchServerEntityIdMap();

    if (serverIdMap.size === 0) {
      console.warn(`  WARNING: Could not fetch entity registry from server — skipping numericId verification.`);
    } else {
      let conflictFound = false;
      let verified = 0;
      let notInServer = 0;
      for (const entity of yamlEntitiesWithManualIds) {
        const serverNumericId = serverIdMap.get(entity.id);
        if (!serverNumericId) {
          // Server has no record for this slug — new entity, skip
          notInServer++;
          continue;
        }
        verified++;
        if (serverNumericId !== entity.numericId) {
          console.error(`    ERROR: numericId conflict for YAML entity "${entity.id}":`);
          console.error(`      Locally set:       ${entity.numericId}`);
          console.error(`      Server registered: ${serverNumericId}`);
          console.error(`      Fix: update numericId in data/entities/ to "${serverNumericId}",`);
          console.error(`           or ask an admin to register "${entity.numericId}" for "${entity.id}" on the server.`);
          conflictFound = true;
        }
      }
      if (conflictFound) {
        console.error('\n  Manual numericId bypass detected. Aborting to prevent ID registry corruption.');
        process.exit(1);
      }
      const notInServerNote = notInServer > 0 ? ` (${notInServer} not yet in server — OK for new entities)` : '';
      console.log(`  Verification complete: ${verified} numericIds verified OK${notInServerNote}.`);
    }
  } else if (yamlEntitiesWithManualIds.length > 0 && !serverAvailable && !DRY_RUN) {
    console.warn(`  WARNING: Server unavailable — skipping verification of ${yamlEntitiesWithManualIds.length} manually-set YAML entity numericIds.`);
  }

  // -------------------------------------------------------------------------
  // Assign IDs to entities without one via the server.
  // YAML entities without numericIds are skipped — they cannot be written
  // back automatically and must be updated in the source YAML manually.
  // -------------------------------------------------------------------------
  let yamlSkipped = 0;
  const entitiesNeedingIds = [];

  for (const entity of entities) {
    if (entity.numericId) continue;

    if (entity._source !== 'frontmatter' || !entity._filePath) {
      // YAML entity without numericId — can't write back, skip
      console.warn(`    WARNING: ${entity.id} (YAML entity) has no numericId — add it manually to the source YAML`);
      yamlSkipped++;
      continue;
    }

    entitiesNeedingIds.push(entity);
  }

  if (entitiesNeedingIds.length > 0 && DRY_RUN) {
    for (const entity of entitiesNeedingIds) {
      console.log(`    [dry-run] Would assign ID → ${entity.id} (MDX frontmatter)`);
    }
  } else if (entitiesNeedingIds.length > 0) {
    if (!serverAvailable) {
      console.error('  ERROR: Wiki server is not available but new entities need IDs.');
      console.error('  Set LONGTERMWIKI_SERVER_URL and ensure the server is running.');
      console.error('  ID assignment requires the server for atomic, consistent allocation.');
      process.exit(1);
    }

    const slugs = entitiesNeedingIds.map(e => e.id);
    console.log(`  Allocating ${slugs.length} entity IDs in batch...`);
    const allocated = await allocateIds(slugs);

    for (const entity of entitiesNeedingIds) {
      const numId = allocated.get(entity.id);
      if (!numId) {
        console.error(`    ERROR: Batch allocation did not return ID for entity "${entity.id}"`);
        process.exit(1);
      }

      entity.numericId = numId;
      numericIdToSlug[numId] = entity.id;
      slugToNumericId[entity.id] = numId;

      const content = readFileSync(entity._filePath, 'utf-8');
      const updated = content.replace(/^---\n/, `---\nnumericId: ${numId}\n`);
      writeFileSync(entity._filePath, updated);
      console.log(`    Assigned ${numId} → ${entity.id} (wrote to MDX frontmatter)`);
    }
  }

  const entityAssignments = entitiesNeedingIds.length;
  if (entityAssignments > 0 && DRY_RUN) {
    console.log(`  entities: would assign ${entityAssignments} new IDs`);
  } else if (entityAssignments > 0) {
    console.log(`  entities: assigned ${entityAssignments} new IDs (total: ${Object.keys(numericIdToSlug).length})`);
  } else {
    console.log(`  entities: ${Object.keys(numericIdToSlug).length} entities all have IDs${yamlSkipped > 0 ? ` (${yamlSkipped} YAML entities need manual numericId)` : ''}`);
  }

  // -------------------------------------------------------------------------
  // Scan pages and assign page-level numericIds
  // -------------------------------------------------------------------------
  const pages = scanPages();
  const entityIds = new Set(entities.map(e => e.id));
  const eligiblePages = filterEligiblePages(pages, entityIds, SKIP_CATEGORIES);

  // Pass 1: collect existing page numericIds from frontmatter
  for (const page of eligiblePages) {
    if (slugToNumericId[page.id]) continue; // already assigned (entity or prior pass)

    if (page.numericId) {
      const existingOwner = numericIdToSlug[page.numericId];
      if (existingOwner && existingOwner !== page.id) {
        console.warn(`    WARNING: ${page.numericId} claimed by "${existingOwner}" and page "${page.id}" — keeping "${existingOwner}"`);
      }
      if (!numericIdToSlug[page.numericId]) {
        numericIdToSlug[page.numericId] = page.id;
      }
      slugToNumericId[page.id] = page.numericId;
    }
  }

  // Pass 2: assign new IDs to pages that don't have one yet
  const pagesNeedingIds = eligiblePages.filter(p => !slugToNumericId[p.id]);

  if (pagesNeedingIds.length > 0 && DRY_RUN) {
    for (const page of pagesNeedingIds) {
      console.log(`    [dry-run] Would assign ID → ${page.id} (MDX frontmatter)`);
    }
  } else if (pagesNeedingIds.length > 0) {
    if (!serverAvailable) {
      console.error('  ERROR: Wiki server is not available but new pages need IDs.');
      console.error('  Set LONGTERMWIKI_SERVER_URL and ensure the server is running.');
      console.error('  ID assignment requires the server for atomic, consistent allocation.');
      process.exit(1);
    }

    const slugs = pagesNeedingIds.map(p => p.id);
    console.log(`  Allocating ${slugs.length} page IDs in batch...`);
    const allocated = await allocateIds(slugs);

    for (const page of pagesNeedingIds) {
      const numId = allocated.get(page.id);
      if (!numId) {
        console.error(`    ERROR: Batch allocation did not return ID for page "${page.id}"`);
        process.exit(1);
      }

      numericIdToSlug[numId] = page.id;
      slugToNumericId[page.id] = numId;
      page.numericId = numId;

      const content = readFileSync(page._fullPath, 'utf-8');
      const updated = content.replace(/^---\n/, `---\nnumericId: ${numId}\n`);
      writeFileSync(page._fullPath, updated);
      console.log(`    Assigned ${numId} → ${page.id} (wrote to MDX frontmatter)`);
    }
  }

  const pageAssignments = pagesNeedingIds.length;
  if (pageAssignments > 0 && DRY_RUN) {
    console.log(`  pages: would assign ${pageAssignments} new page IDs`);
  } else if (pageAssignments > 0) {
    console.log(`  pages: assigned ${pageAssignments} new page IDs`);
  } else {
    console.log(`  pages: all eligible pages have IDs`);
  }

  console.log(DRY_RUN ? '\n[dry-run] No files were written.' : '\nID assignment complete.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
