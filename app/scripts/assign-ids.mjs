/**
 * assign-ids.mjs — Pre-build ID assignment step
 *
 * Scans source files (YAML entities + MDX frontmatter) for entities and pages
 * without numericIds, assigns new IDs, and writes them back to source files.
 *
 * This runs as a dedicated pre-build step before build-data.mjs, ensuring:
 *   1. All source file mutations complete before the main build starts
 *   2. If this step fails midway, re-running it is safe (idempotent)
 *   3. The main build (build-data.mjs) is purely read-only w.r.t. source files
 *
 * Usage:
 *   node scripts/assign-ids.mjs [--allow-id-reassignment] [--dry-run]
 *
 * Resolves: https://github.com/quantified-uncertainty/longterm-wiki/issues/245
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, basename, relative } from 'path';
import { parse } from 'yaml';
import { CONTENT_DIR, DATA_DIR, TOP_LEVEL_CONTENT_DIRS } from './lib/content-types.mjs';
import { scanFrontmatterEntities } from './lib/frontmatter-scanner.mjs';
import { detectReassignments, scanEntityLinkRefs, formatReassignments } from './lib/id-stability.mjs';

const ALLOW_ID_REASSIGNMENT = process.argv.includes('--allow-id-reassignment');
const DRY_RUN = process.argv.includes('--dry-run');

const ID_REGISTRY_FILE = join(DATA_DIR, 'id-registry.json');

// Categories to skip when assigning page IDs (mirrors build-data.mjs)
const SKIP_CATEGORIES = new Set([
  'style-guides', 'browse',
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

/**
 * Run the stability check and exit on failure.
 */
function checkStability(prevRegistry, numericIdToSlug, slugToNumericId, phase) {
  if (!prevRegistry?.entities || ALLOW_ID_REASSIGNMENT) return;

  const reassignments = detectReassignments(prevRegistry, numericIdToSlug, slugToNumericId);
  if (reassignments.length === 0) return;

  const { lines, affectedIds } = formatReassignments(reassignments);
  const CONTENT_SCAN_DIR = join(DATA_DIR, '..', 'content', 'docs');
  const brokenRefs = scanEntityLinkRefs(CONTENT_SCAN_DIR, affectedIds);

  console.error(`\n  ERROR: Numeric ID reassignment detected at ${phase} level! (issue #148)`);
  console.error('  The following IDs changed between builds:\n');
  for (const line of lines) console.error(`  ${line}`);

  if (brokenRefs.length > 0) {
    console.error(`\n  ${brokenRefs.length} EntityLink reference(s) would break:\n`);
    for (const ref of brokenRefs) {
      const relPath = relative(CONTENT_SCAN_DIR, ref.file);
      console.error(`    ${relPath}:${ref.line} — id="${ref.id}"`);
    }
  }

  console.error('\n  To fix: restore the original numericId values in source files.');
  console.error('  To override: re-run with --allow-id-reassignment\n');
  process.exit(1);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  if (DRY_RUN) {
    console.log('[dry-run] Checking which IDs would be assigned (no files written)\n');
  }

  // -------------------------------------------------------------------------
  // Load previous registry for stability checks
  // -------------------------------------------------------------------------
  let prevRegistry = null;
  if (existsSync(ID_REGISTRY_FILE)) {
    try {
      prevRegistry = JSON.parse(readFileSync(ID_REGISTRY_FILE, 'utf-8'));
    } catch {
      // Corrupted — will be regenerated
    }
  }

  // -------------------------------------------------------------------------
  // Collect existing numericIds from YAML entities + frontmatter entities
  // -------------------------------------------------------------------------
  const yamlEntityItems = loadYamlEntityIds();
  const yamlEntityIds = new Set(yamlEntityItems.map(e => e.id));
  const frontmatterEntities = scanFrontmatterEntities(yamlEntityIds, CONTENT_DIR);
  const entities = [...yamlEntityItems, ...frontmatterEntities];

  const slugToNumericId = {};
  const numericIdToSlug = {};
  const conflicts = [];

  for (const entity of entities) {
    if (entity.numericId) {
      if (numericIdToSlug[entity.numericId] && numericIdToSlug[entity.numericId] !== entity.id) {
        conflicts.push(
          `${entity.numericId} claimed by both "${numericIdToSlug[entity.numericId]}" and "${entity.id}"`
        );
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

  // -------------------------------------------------------------------------
  // Compute next available ID from existing assignments.
  // Scan MDX frontmatter to reserve page-level IDs already declared there,
  // so auto-assigned entity IDs don't collide with them.
  // -------------------------------------------------------------------------
  let nextId = 1;
  for (const numId of Object.keys(numericIdToSlug)) {
    const n = parseInt(numId.slice(1));
    if (n >= nextId) nextId = n + 1;
  }

  function reserveFrontmatterIds(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        reserveFrontmatterIds(join(dir, entry.name));
      } else if (entry.name.endsWith('.mdx') || entry.name.endsWith('.md')) {
        const content = readFileSync(join(dir, entry.name), 'utf-8');
        const match = content.match(/^numericId:\s*(E\d+)/m);
        if (match) {
          const n = parseInt(match[1].slice(1));
          if (n >= nextId) nextId = n + 1;
        }
      }
    }
  }
  reserveFrontmatterIds(CONTENT_DIR);

  // -------------------------------------------------------------------------
  // Stability check (entity-level) — detect silent reassignments (#148)
  // -------------------------------------------------------------------------
  checkStability(prevRegistry, numericIdToSlug, slugToNumericId, 'entity');

  // -------------------------------------------------------------------------
  // Assign IDs to entities without one, write back to source files.
  // YAML entities without numericIds are skipped — they cannot be written
  // back automatically and must be updated in the source YAML manually.
  // Skipping them keeps the registry stable across runs.
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

      const numId = `E${nextId}`;
      entity.numericId = numId;
      numericIdToSlug[numId] = entity.id;
      slugToNumericId[entity.id] = numId;
      nextId++;
      entityAssignments++;

      if (DRY_RUN) {
        console.log(`    [dry-run] Would assign ${numId} → ${entity.id} (MDX frontmatter)`);
      } else {
        const content = readFileSync(entity._filePath, 'utf-8');
        const updated = content.replace(/^---\n/, `---\nnumericId: ${numId}\n`);
        writeFileSync(entity._filePath, updated);
        console.log(`    Assigned ${numId} → ${entity.id} (wrote to MDX frontmatter)`);
      }
    }
  }

  // Write intermediate registry (entity-level assignments complete).
  // Only includes IDs that are actually persisted in source files — YAML
  // entities without numericIds are excluded to keep the registry stable.
  if (!DRY_RUN) {
    writeFileSync(
      ID_REGISTRY_FILE,
      JSON.stringify({ _nextId: nextId, entities: numericIdToSlug }, null, 2)
    );
  }

  if (entityAssignments > 0) {
    console.log(`  entities: assigned ${entityAssignments} new IDs (total: ${Object.keys(numericIdToSlug).length})`);
  } else {
    console.log(`  entities: ${Object.keys(numericIdToSlug).length} entities all have IDs${yamlSkipped > 0 ? ` (${yamlSkipped} YAML entities need manual numericId)` : ''}`);
  }

  // -------------------------------------------------------------------------
  // Scan pages and collect/assign page-level numericIds
  // -------------------------------------------------------------------------
  const pages = scanPages();
  const entityIds = new Set(entities.map(e => e.id));
  // Pass 1: collect existing page numericIds from frontmatter
  for (const page of pages) {
    if (entityIds.has(page.id)) continue;
    if (slugToNumericId[page.id]) continue;
    if (SKIP_CATEGORIES.has(page.category)) continue;
    if (page.contentFormat === 'dashboard') continue;

    if (page.numericId) {
      const existingOwner = numericIdToSlug[page.numericId];
      if (existingOwner && existingOwner !== page.id) {
        // Generated MDX stubs may share a numericId with their parent entity
        // (e.g. page "epistemics" inherits E319 from entity "tmc-epistemics").
        // That's expected — warn and keep the entity's ownership.
        console.warn(`    WARNING: ${page.numericId} claimed by "${existingOwner}" and page "${page.id}" — keeping "${existingOwner}"`);
      }
      if (!numericIdToSlug[page.numericId]) {
        numericIdToSlug[page.numericId] = page.id;
      }
      slugToNumericId[page.id] = page.numericId;
    }
  }

  // Stability check (page-level) — full check now that all IDs are collected
  checkStability(prevRegistry, numericIdToSlug, slugToNumericId, 'page');

  // Pass 2: assign new IDs to pages that don't have one yet
  let pageAssignments = 0;
  for (const page of pages) {
    if (entityIds.has(page.id)) continue;
    if (slugToNumericId[page.id]) continue;
    if (SKIP_CATEGORIES.has(page.category)) continue;
    if (page.contentFormat === 'dashboard') continue;

    const numId = `E${nextId}`;
    numericIdToSlug[numId] = page.id;
    slugToNumericId[page.id] = numId;
    page.numericId = numId;
    nextId++;
    pageAssignments++;

    if (DRY_RUN) {
      console.log(`    [dry-run] Would assign ${numId} → ${page.id} (MDX frontmatter)`);
    } else {
      const content = readFileSync(page._fullPath, 'utf-8');
      const updated = content.replace(/^---\n/, `---\nnumericId: ${numId}\n`);
      writeFileSync(page._fullPath, updated);
      console.log(`    Assigned ${numId} → ${page.id} (wrote to MDX frontmatter)`);
    }
  }

  // Write final registry (all assignments complete)
  if (!DRY_RUN) {
    writeFileSync(
      ID_REGISTRY_FILE,
      JSON.stringify({ _nextId: nextId, entities: numericIdToSlug }, null, 2)
    );
  }

  if (pageAssignments > 0) {
    console.log(`  pages: assigned ${pageAssignments} new page IDs (total: ${Object.keys(numericIdToSlug).length})`);
  } else {
    console.log(`  pages: all eligible pages have IDs`);
  }

  console.log(DRY_RUN ? '\n[dry-run] No files were written.' : '\nID assignment complete.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
