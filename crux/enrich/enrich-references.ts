/**
 * References Enrichment Tool
 *
 * Appends or updates a <References> block at the end of MDX pages by:
 *   1. Extracting existing <R id="..."> inline citations from the content
 *   2. Looking up the page in the cited_by reverse index from resource YAML
 *   3. Merging both sources, deduplicating, and emitting the block
 *
 * Idempotent: if a <References> block already exists with the same IDs,
 * no changes are made. If new IDs are found, the block is replaced.
 *
 * No LLM calls — purely mechanical. Cost: $0.
 *
 * Usage (CLI):
 *   pnpm crux enrich references <page-id>           # Preview (dry run)
 *   pnpm crux enrich references <page-id> --apply   # Write to file
 *   pnpm crux enrich references --all [--limit=N]   # Batch across wiki
 *
 * Usage (library):
 *   import { enrichReferences } from './enrich-references.ts';
 *   const result = enrichReferences(content, { pageId: 'anthropic', root: ROOT });
 */

import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { CONTENT_DIR_ABS, PROJECT_ROOT } from '../lib/content-types.ts';
import { findMdxFiles, findPageFile } from '../lib/file-utils.ts';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReferencesEnrichResult {
  /** The enriched content (with References block appended/updated). */
  content: string;
  /** Number of resource IDs in the final References block. */
  refCount: number;
  /** Whether the block was newly added (vs updated or unchanged). */
  action: 'added' | 'updated' | 'unchanged' | 'none';
  /** Resource IDs in the final block. */
  ids: string[];
}

interface ResourceEntry {
  id: string;
  url?: string;
  title?: string;
  cited_by?: string[];
}

// ---------------------------------------------------------------------------
// Resource loading & index building
// ---------------------------------------------------------------------------

let _resourceCache: ResourceEntry[] | null = null;
let _citedByCache: Map<string, Set<string>> | null = null;
let _validIdCache: Set<string> | null = null;

function loadResources(root: string): ResourceEntry[] {
  if (_resourceCache) return _resourceCache;
  const dir = join(root, 'data/resources');
  const files = readdirSync(dir).filter(f => f.endsWith('.yaml'));
  const all: ResourceEntry[] = [];
  for (const file of files) {
    const raw = readFileSync(join(dir, file), 'utf-8');
    const parsed = parseYaml(raw);
    if (Array.isArray(parsed)) all.push(...parsed);
  }
  _resourceCache = all;
  return all;
}

function getCitedByIndex(root: string): Map<string, Set<string>> {
  if (_citedByCache) return _citedByCache;
  const resources = loadResources(root);
  const index = new Map<string, Set<string>>();
  for (const r of resources) {
    if (!r.cited_by || !Array.isArray(r.cited_by)) continue;
    for (const pageId of r.cited_by) {
      if (!index.has(pageId)) index.set(pageId, new Set());
      index.get(pageId)!.add(r.id);
    }
  }
  _citedByCache = index;
  return index;
}

function getValidIds(root: string): Set<string> {
  if (_validIdCache) return _validIdCache;
  _validIdCache = new Set(loadResources(root).map(r => r.id));
  return _validIdCache;
}

// ---------------------------------------------------------------------------
// Core extraction logic
// ---------------------------------------------------------------------------

/** Extract all <R id="..."> resource IDs from MDX content. */
function extractInlineResourceIds(content: string): string[] {
  const ids: string[] = [];
  const re = /<R\s+[^>]*id="([a-f0-9]+)"[^>]*>/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    ids.push(m[1]);
  }
  return ids;
}

/** Extract the page slug (last path segment) from a full page ID. */
function slugFromPageId(pageId: string): string {
  const parts = pageId.split('/');
  return parts[parts.length - 1];
}

/** Check if a <References block already exists, and extract its current IDs. */
function parseExistingReferences(content: string): { exists: boolean; ids: string[]; blockStart: number; blockEnd: number } {
  const re = /<References\s[\s\S]*?\/>/m;
  const m = re.exec(content);
  if (!m) return { exists: false, ids: [], blockStart: -1, blockEnd: -1 };

  // Extract IDs from the block
  const block = m[0];
  const idRe = /"([a-f0-9]{16})"/g;
  const ids: string[] = [];
  let idMatch;
  while ((idMatch = idRe.exec(block)) !== null) {
    ids.push(idMatch[1]);
  }

  return { exists: true, ids, blockStart: m.index, blockEnd: m.index + m[0].length };
}

/** Build the <References> block string. */
function buildReferencesBlock(pageSlug: string, ids: string[]): string {
  const idLines = ids.map(id => `    "${id}",`).join('\n');
  return `<References\n  pageId="${pageSlug}"\n  ids={[\n${idLines}\n  ]}\n/>`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enrich page content with a <References> block.
 *
 * @param content - MDX page content
 * @param options.pageId - Page slug (e.g. "anthropic"). Required for cited_by lookup.
 * @param options.root - Project root (default: auto-detect)
 * @returns Enriched content and metadata
 */
export function enrichReferences(
  content: string,
  options: { pageId?: string; root?: string } = {},
): ReferencesEnrichResult {
  const root = options.root ?? PROJECT_ROOT;
  const pageId = options.pageId ?? '';
  const slug = slugFromPageId(pageId);

  const validIds = getValidIds(root);
  const citedByIndex = getCitedByIndex(root);

  // Collect IDs from inline <R> tags
  const inlineIds = extractInlineResourceIds(content);

  // Collect IDs from cited_by reverse index
  const citedByIds = citedByIndex.get(slug) ?? new Set<string>();

  // Merge: inline first (preserves page order), then cited_by additions
  const mergedIds: string[] = [];
  const seen = new Set<string>();
  for (const id of inlineIds) {
    if (!seen.has(id) && validIds.has(id)) {
      seen.add(id);
      mergedIds.push(id);
    }
  }
  for (const id of citedByIds) {
    if (!seen.has(id) && validIds.has(id)) {
      seen.add(id);
      mergedIds.push(id);
    }
  }

  if (mergedIds.length === 0) {
    return { content, refCount: 0, action: 'none', ids: [] };
  }

  // Check existing References block
  const existing = parseExistingReferences(content);

  if (existing.exists) {
    // Compare: same IDs in same order → unchanged
    const existingSet = new Set(existing.ids);
    const mergedSet = new Set(mergedIds);
    const sameIds = existingSet.size === mergedSet.size &&
      [...existingSet].every(id => mergedSet.has(id));

    if (sameIds) {
      return { content, refCount: mergedIds.length, action: 'unchanged', ids: mergedIds };
    }

    // Replace existing block with updated one
    const newBlock = buildReferencesBlock(slug, mergedIds);
    const updated = content.slice(0, existing.blockStart) + newBlock + content.slice(existing.blockEnd);
    return { content: updated, refCount: mergedIds.length, action: 'updated', ids: mergedIds };
  }

  // Append new block
  const newBlock = buildReferencesBlock(slug, mergedIds);
  const trimmed = content.trimEnd();
  return { content: trimmed + '\n\n' + newBlock + '\n', refCount: mergedIds.length, action: 'added', ids: mergedIds };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const c = getColors();
  const apply = !!args.apply;
  const all = !!args.all;
  const limit = typeof args.limit === 'number' ? args.limit : Infinity;
  const json = !!args.json;
  const pageId = args._positional?.[0];

  if (!all && !pageId) {
    console.error('Usage: crux enrich references <page-id> [--apply] | crux enrich references --all [--limit=N]');
    process.exit(1);
  }

  const root = PROJECT_ROOT;

  if (all) {
    // Batch mode
    const files = findMdxFiles(CONTENT_DIR_ABS).slice(0, limit);
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    let none = 0;

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const relPath = file.replace(CONTENT_DIR_ABS + '/', '').replace(/\.mdx$/, '');
      const slug = slugFromPageId(relPath);
      const result = enrichReferences(content, { pageId: slug, root });

      if (result.action === 'none') { none++; continue; }
      if (result.action === 'unchanged') { unchanged++; continue; }

      if (json) {
        console.log(JSON.stringify({ page: slug, action: result.action, refCount: result.refCount }));
      } else {
        console.log(`${c.green}${result.action}${c.reset}: ${slug} (${result.refCount} refs)`);
      }

      if (apply) {
        writeFileSync(file, result.content);
      }

      if (result.action === 'added') added++;
      if (result.action === 'updated') updated++;
    }

    if (!json) {
      console.log(`\n${c.bold}Summary:${c.reset} ${added} added, ${updated} updated, ${unchanged} unchanged, ${none} no resources`);
      if (!apply && (added + updated) > 0) {
        console.log(`Run with --apply to write changes.`);
      }
    }
  } else {
    // Single page
    const filePath = findPageFile(pageId!);
    if (!filePath) {
      console.error(`Page not found: ${pageId}`);
      process.exit(1);
    }

    const content = readFileSync(filePath, 'utf-8');
    const result = enrichReferences(content, { pageId: pageId!, root });

    if (json) {
      console.log(JSON.stringify({ page: pageId, action: result.action, refCount: result.refCount, ids: result.ids }));
    } else {
      console.log(`${c.bold}${pageId}${c.reset}: ${result.action} (${result.refCount} refs)`);
      if (result.action === 'added' || result.action === 'updated') {
        console.log(`IDs: ${result.ids.slice(0, 5).join(', ')}${result.ids.length > 5 ? ` ... (${result.ids.length} total)` : ''}`);
      }
    }

    if (apply && (result.action === 'added' || result.action === 'updated')) {
      writeFileSync(filePath, result.content);
      console.log(`${c.green}Written to ${filePath}${c.reset}`);
    } else if (!apply && result.action !== 'none' && result.action !== 'unchanged') {
      console.log(`Run with --apply to write changes.`);
    }
  }
}

import { fileURLToPath as _fileURLToPath } from 'url';
if (process.argv[1] === _fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
