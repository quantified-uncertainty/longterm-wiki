/**
 * ID Stability Check — detect silent numeric ID reassignments (issue #148)
 *
 * Compares a newly collected slug↔ID mapping against a previous registry
 * snapshot and detects any reassignments that would break EntityLink
 * references in MDX content.
 *
 * Usage:
 *   import { detectReassignments, scanEntityLinkRefs, runStabilityCheck } from './lib/id-stability.mjs';
 *
 *   const reassignments = detectReassignments(prevRegistry, numericIdToSlug, slugToNumericId);
 *   if (reassignments.length > 0) { ... }
 *
 *   // Or use the higher-level helper that handles error output + exit:
 *   runStabilityCheck(prevRegistry, numericIdToSlug, slugToNumericId, { phase: 'entity', contentDir, allowReassignment });
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';

/**
 * Detect ID reassignments between an old registry and newly collected mappings.
 *
 * @param {Object} prevRegistry  Previous id-registry.json content ({ entities: { E1: "slug", ... } })
 * @param {Object} numericIdToSlug  New mapping: numericId → slug
 * @param {Object} slugToNumericId  New mapping: slug → numericId
 * @returns {Array<{type: string, slug?: string, numId?: string, oldId?: string, newId?: string, oldSlug?: string, newSlug?: string}>}
 */
export function detectReassignments(prevRegistry, numericIdToSlug, slugToNumericId) {
  const reassignments = [];

  if (!prevRegistry?.entities) return reassignments;

  const prevEntities = prevRegistry.entities;

  // Build reverse map: slug → numericId from previous registry
  const prevSlugToId = {};
  for (const [numId, slug] of Object.entries(prevEntities)) {
    prevSlugToId[slug] = numId;
  }

  // Check 1: slug that had an ID now has a different ID
  for (const [slug, newId] of Object.entries(slugToNumericId)) {
    const oldId = prevSlugToId[slug];
    if (oldId && oldId !== newId) {
      reassignments.push({ type: 'slug-changed', slug, oldId, newId });
    }
  }

  // Check 2: numeric ID that pointed to one slug now points to a different slug
  for (const [numId, newSlug] of Object.entries(numericIdToSlug)) {
    const oldSlug = prevEntities[numId];
    if (oldSlug && oldSlug !== newSlug) {
      reassignments.push({ type: 'id-changed', numId, oldSlug, newSlug });
    }
  }

  // Note: we intentionally do NOT check for IDs that are in the old registry
  // but completely absent from the new one. The registry contains both entity-
  // level and page-level IDs, and at the time this check runs during build,
  // page-level IDs haven't been collected yet. Entities that are intentionally
  // deleted are already caught by the entitylink-ids validation rule.

  return reassignments;
}

/**
 * Scan content files for EntityLink references using specific numeric IDs.
 *
 * @param {string} dir  Root directory to scan (e.g., content/docs)
 * @param {Set<string>} numericIds  Set of numeric IDs to search for (e.g., new Set(["E694"]))
 * @returns {Array<{file: string, line: number, id: string}>}
 */
export function scanEntityLinkRefs(dir, numericIds) {
  const results = [];
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...scanEntityLinkRefs(fullPath, numericIds));
    } else if (entry.name.endsWith('.mdx') || entry.name.endsWith('.md')) {
      const content = readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const regex = /<EntityLink\s+[^>]*id="(E\d+)"/g;
        let match;
        while ((match = regex.exec(lines[i])) !== null) {
          if (numericIds.has(match[1])) {
            results.push({ file: fullPath, line: i + 1, id: match[1] });
          }
        }
      }
    }
  }
  return results;
}

/**
 * Run a stability check and exit with error if reassignments are found.
 *
 * This is the high-level helper used by both build-data.mjs and assign-ids.mjs
 * to enforce ID stability (issue #148). Encapsulates error formatting, EntityLink
 * scanning, and process.exit so callers don't repeat the pattern.
 *
 * @param {Object|null} prevRegistry  Previous id-registry.json content
 * @param {Object} numericIdToSlug  Current mapping: numericId → slug
 * @param {Object} slugToNumericId  Current mapping: slug → numericId
 * @param {Object} opts
 * @param {boolean} [opts.allowReassignment=false]  If true, skip the check
 * @param {string}  [opts.phase='entity']  Label for error messages ('entity' or 'page')
 * @param {string}  opts.contentDir  Root dir to scan for broken EntityLink refs
 */
export function runStabilityCheck(prevRegistry, numericIdToSlug, slugToNumericId, {
  allowReassignment = false,
  phase = 'entity',
  contentDir,
}) {
  if (!prevRegistry?.entities || allowReassignment) return;

  const reassignments = detectReassignments(prevRegistry, numericIdToSlug, slugToNumericId);
  if (reassignments.length === 0) return;

  const { lines, affectedIds } = formatReassignments(reassignments);

  console.error(`\n  ERROR: Numeric ID reassignment detected at ${phase} level! (issue #148)`);
  console.error('  The following IDs changed between builds:\n');
  for (const line of lines) console.error(`  ${line}`);

  if (contentDir) {
    const brokenRefs = scanEntityLinkRefs(contentDir, affectedIds);
    if (brokenRefs.length > 0) {
      console.error(`\n  ${brokenRefs.length} EntityLink reference(s) would break:\n`);
      for (const ref of brokenRefs) {
        const relPath = relative(contentDir, ref.file);
        console.error(`    ${relPath}:${ref.line} — id="${ref.id}"`);
      }
    }
  }

  console.error('\n  To fix: restore the original numericId values in source files.');
  console.error('  To override: re-run with --allow-id-reassignment\n');
  process.exit(1);
}

/**
 * Format reassignment errors for console output.
 *
 * @param {Array} reassignments  Output from detectReassignments()
 * @returns {{lines: string[], affectedIds: Set<string>}}  Formatted lines and set of affected numeric IDs
 */
export function formatReassignments(reassignments) {
  const lines = [];
  const affectedIds = new Set();

  for (const r of reassignments) {
    if (r.type === 'slug-changed') {
      lines.push(`  "${r.slug}": ${r.oldId} → ${r.newId}`);
      affectedIds.add(r.oldId);
    } else if (r.type === 'id-changed') {
      lines.push(`  ${r.numId}: "${r.oldSlug}" → "${r.newSlug}"`);
      affectedIds.add(r.numId);
    }
  }

  return { lines, affectedIds };
}
