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
import { CONTENT_DIR, DATA_DIR, TOP_LEVEL_CONTENT_DIRS } from './lib/content-types.mjs';
import { scanFrontmatterEntities } from './lib/frontmatter-scanner.mjs';
import { buildIdMaps, filterEligiblePages } from './lib/id-assignment.mjs';
import { isServerAvailable, allocateId } from './lib/id-client.mjs';

const DRY_RUN = process.argv.includes('--dry-run');

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
  if (DRY_RUN) {
    console.log('[dry-run] Checking which IDs would be assigned (no files written)\n');
  }

  // Require the wiki server for ID allocation
  const serverAvailable = await isServerAvailable();
  if (!serverAvailable) {
    if (DRY_RUN) {
      console.log('  Wiki server unavailable — dry-run will show entities needing IDs but cannot preview assignments');
    } else {
      console.error('  ERROR: Wiki server is not available.');
      console.error('  Set LONGTERMWIKI_SERVER_URL and ensure the server is running.');
      console.error('  ID assignment requires the server for atomic, consistent allocation.');
      process.exit(1);
    }
  } else {
    console.log(`  Using wiki server at ${process.env.LONGTERMWIKI_SERVER_URL}`);
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
  // Assign IDs to entities without one via the server.
  // YAML entities without numericIds are skipped — they cannot be written
  // back automatically and must be updated in the source YAML manually.
  // -------------------------------------------------------------------------
  let entityAssignments = 0;
  let yamlSkipped = 0;
  for (const entity of entities) {
    if (!entity.numericId) {
      if (entity._source !== 'frontmatter' || !entity._filePath) {
        // YAML entity without numericId — can't write back, skip
        console.warn(`    WARNING: ${entity.id} (YAML entity) has no numericId — add it manually to the source YAML`);
        yamlSkipped++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`    [dry-run] Would assign ID → ${entity.id} (MDX frontmatter)`);
        entityAssignments++;
        continue;
      }

      const result = await allocateId(entity.id);
      if (!result) {
        console.error(`    ERROR: Failed to allocate ID for entity "${entity.id}" — server returned null`);
        process.exit(1);
      }

      const numId = result.numericId;
      entity.numericId = numId;
      numericIdToSlug[numId] = entity.id;
      slugToNumericId[entity.id] = numId;
      entityAssignments++;

      const content = readFileSync(entity._filePath, 'utf-8');
      const updated = content.replace(/^---\n/, `---\nnumericId: ${numId}\n`);
      writeFileSync(entity._filePath, updated);
      console.log(`    Assigned ${numId} → ${entity.id} (wrote to MDX frontmatter)`);
    }
  }

  if (entityAssignments > 0) {
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
  let pageAssignments = 0;
  for (const page of eligiblePages) {
    if (slugToNumericId[page.id]) continue; // already has an ID

    if (DRY_RUN) {
      console.log(`    [dry-run] Would assign ID → ${page.id} (MDX frontmatter)`);
      pageAssignments++;
      continue;
    }

    const result = await allocateId(page.id);
    if (!result) {
      console.error(`    ERROR: Failed to allocate ID for page "${page.id}" — server returned null`);
      process.exit(1);
    }

    const numId = result.numericId;
    numericIdToSlug[numId] = page.id;
    slugToNumericId[page.id] = numId;
    page.numericId = numId;
    pageAssignments++;

    const content = readFileSync(page._fullPath, 'utf-8');
    const updated = content.replace(/^---\n/, `---\nnumericId: ${numId}\n`);
    writeFileSync(page._fullPath, updated);
    console.log(`    Assigned ${numId} → ${page.id} (wrote to MDX frontmatter)`);
  }

  if (pageAssignments > 0) {
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
