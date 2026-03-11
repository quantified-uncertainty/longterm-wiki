#!/usr/bin/env -S node --import tsx/esm
/**
 * Wire References component into wiki pages.
 *
 * Phase 1: Extract existing <R id="..."> usage from pages → append <References> block
 * Phase 2: Use cited_by reverse index from resource YAML → add References for tagged pages
 *
 * Usage:
 *   npx tsx crux/scripts/wire-references.ts                # Dry run (default)
 *   npx tsx crux/scripts/wire-references.ts --apply        # Write changes
 *   npx tsx crux/scripts/wire-references.ts --apply --verbose
 */

import fs from 'fs';
import path from 'path';

import { loadResources } from '../resource-io.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CONTENT_DIR = path.join(ROOT, 'content/docs');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const VERBOSE = args.includes('--verbose');

// ─── Resource Loading (uses centralized loader from resource-io) ─────

interface ResourceEntry {
  id: string;
  url?: string;
  title?: string;
  cited_by?: string[];
}

function loadAllResources(): ResourceEntry[] {
  return loadResources();
}

/** Build reverse index: pageId → Set<resourceId> from cited_by fields */
function buildCitedByIndex(resources: ResourceEntry[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const r of resources) {
    if (!r.cited_by || !Array.isArray(r.cited_by)) continue;
    for (const pageId of r.cited_by) {
      if (!index.has(pageId)) index.set(pageId, new Set());
      index.get(pageId)!.add(r.id);
    }
  }
  return index;
}

// ─── MDX Scanning ────────────────────────────────────────────────────

/** Extract all <R id="..."> resource IDs from MDX content */
function extractInlineResourceIds(content: string): string[] {
  const ids: string[] = [];
  // Match <R id="hexid">, <R id="hexid" n={N}>, etc.
  const re = /<R\s+[^>]*id="([a-f0-9]+)"[^>]*>/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}

/** Check if page already has a <References block */
function hasReferencesBlock(content: string): boolean {
  return /<References\s/m.test(content);
}

/** Derive pageId from file path */
function fileToPageId(filePath: string): string {
  const rel = path.relative(CONTENT_DIR, filePath);
  // Remove .mdx extension and convert path separators
  return rel.replace(/\.mdx$/, '').replace(/\//g, '/');
}

/** Derive the slug (last segment) used in cited_by from a full page path */
function pageIdToSlug(pageId: string): string {
  // cited_by uses the last path segment, e.g. "knowledge-base/organizations/anthropic" → "anthropic"
  const parts = pageId.split('/');
  return parts[parts.length - 1];
}

// ─── References Block Generation ─────────────────────────────────────

function generateReferencesBlock(pageSlug: string, ids: string[]): string {
  // Deduplicate while preserving order
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(id);
    }
  }

  const idLines = unique.map(id => `    "${id}",`).join('\n');
  return `\n<References\n  pageId="${pageSlug}"\n  ids={[\n${idLines}\n  ]}\n/>`;
}

// ─── Main ────────────────────────────────────────────────────────────

function getAllMdxFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllMdxFiles(fullPath));
    } else if (entry.name.endsWith('.mdx')) {
      results.push(fullPath);
    }
  }
  return results;
}

function main() {
  console.log(APPLY ? '🔧 APPLY mode — writing changes' : '📋 DRY RUN — no files will be modified');
  console.log();

  // Load resources
  const resources = loadAllResources();
  console.log(`Loaded ${resources.length} resources from ${RESOURCES_DIR}`);

  // Build cited_by reverse index
  const citedByIndex = buildCitedByIndex(resources);
  console.log(`cited_by index: ${citedByIndex.size} pages have tagged resources`);

  // Build resource ID set for validation
  const validResourceIds = new Set(resources.map(r => r.id));

  // Scan all MDX files
  const mdxFiles = getAllMdxFiles(CONTENT_DIR);
  console.log(`Found ${mdxFiles.length} MDX files`);
  console.log();

  let wiredCount = 0;
  let skippedAlready = 0;
  let skippedNoResources = 0;
  const wiredPages: { pageId: string; slug: string; inlineCount: number; citedByCount: number; totalIds: number }[] = [];

  for (const filePath of mdxFiles) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const pageId = fileToPageId(filePath);
    const slug = pageIdToSlug(pageId);

    // Skip if already has References
    if (hasReferencesBlock(content)) {
      skippedAlready++;
      if (VERBOSE) console.log(`  SKIP (already has References): ${pageId}`);
      continue;
    }

    // Collect resource IDs from two sources
    const inlineIds = extractInlineResourceIds(content);
    const citedByIds = citedByIndex.get(slug) ?? new Set<string>();

    // Merge: inline first (preserves page order), then cited_by additions
    const allIds: string[] = [...inlineIds];
    const inlineSet = new Set(inlineIds);
    for (const id of citedByIds) {
      if (!inlineSet.has(id)) {
        allIds.push(id);
      }
    }

    // Filter to only valid resource IDs
    const validIds = allIds.filter(id => validResourceIds.has(id));

    if (validIds.length === 0) {
      skippedNoResources++;
      continue;
    }

    // Generate and append References block
    const refsBlock = generateReferencesBlock(slug, validIds);

    if (APPLY) {
      // Trim trailing whitespace/newlines from content, then append
      const trimmed = content.trimEnd();
      fs.writeFileSync(filePath, trimmed + '\n' + refsBlock + '\n');
    }

    wiredCount++;
    wiredPages.push({
      pageId,
      slug,
      inlineCount: inlineIds.length,
      citedByCount: citedByIds.size,
      totalIds: validIds.length,
    });

    if (VERBOSE) {
      console.log(`  WIRE: ${pageId} (${inlineIds.length} inline + ${citedByIds.size} cited_by → ${validIds.length} refs)`);
    }
  }

  // Summary
  console.log('─'.repeat(60));
  console.log(`Results:`);
  console.log(`  Wired:              ${wiredCount} pages`);
  console.log(`  Skipped (already):  ${skippedAlready} pages`);
  console.log(`  Skipped (no refs):  ${skippedNoResources} pages`);
  console.log();

  if (wiredPages.length > 0) {
    // Breakdown by source
    const inlineOnly = wiredPages.filter(p => p.inlineCount > 0 && p.citedByCount === 0);
    const citedByOnly = wiredPages.filter(p => p.inlineCount === 0 && p.citedByCount > 0);
    const both = wiredPages.filter(p => p.inlineCount > 0 && p.citedByCount > 0);

    console.log(`  From inline <R> only:   ${inlineOnly.length} pages`);
    console.log(`  From cited_by only:     ${citedByOnly.length} pages`);
    console.log(`  Both sources:           ${both.length} pages`);
    console.log();

    // Top pages by ref count
    const sorted = [...wiredPages].sort((a, b) => b.totalIds - a.totalIds);
    console.log('Top 10 pages by reference count:');
    for (const p of sorted.slice(0, 10)) {
      console.log(`  ${p.totalIds.toString().padStart(3)} refs  ${p.slug}`);
    }
  }

  if (!APPLY && wiredCount > 0) {
    console.log();
    console.log(`Run with --apply to write changes.`);
  }
}

main();
