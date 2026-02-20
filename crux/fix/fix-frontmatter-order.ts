#!/usr/bin/env node

/**
 * Frontmatter Field Order Fixer
 *
 * Reorders MDX frontmatter fields to follow the canonical ordering defined
 * in crux/lib/frontmatter-order.ts. This minimizes git merge conflicts by
 * placing stable "identity" fields first and volatile "metadata" fields last.
 *
 * The fixer operates on raw text lines (not YAML serialization) to preserve
 * exact formatting, comments, and quoting style.
 *
 * Usage:
 *   pnpm crux fix frontmatter-order              # Preview changes (dry run)
 *   pnpm crux fix frontmatter-order --apply       # Apply changes
 *   pnpm crux fix frontmatter-order --verbose     # Show per-file details
 *   pnpm crux fix frontmatter-order --file=path   # Fix single file only
 *
 * See: https://github.com/quantified-uncertainty/longterm-wiki/issues/398
 */

import { readFileSync, writeFileSync } from 'fs';
import { findMdxFiles } from '../lib/file-utils.ts';
import { getColors, formatPath } from '../lib/output.ts';
import { CONTENT_DIR_ABS as CONTENT_DIR } from '../lib/content-types.ts';
import { logBulkFixes } from '../lib/edit-log.ts';
import { getFieldSortIndex } from '../lib/frontmatter-order.ts';

const args: string[] = process.argv.slice(2);
const APPLY_MODE: boolean = args.includes('--apply');
const VERBOSE: boolean = args.includes('--verbose');
const HELP: boolean = args.includes('--help');
const SINGLE_FILE: string | undefined = args.find(a => a.startsWith('--file='))?.split('=')[1];

const colors = getColors();

if (HELP) {
  console.log(`
${colors.bold}Frontmatter Field Order Fixer${colors.reset}

Reorders MDX frontmatter fields to follow canonical ordering:
  1. Identity (numericId, title, description)
  2. Structure (sidebar, entityType, subcategory, ...)
  3. Quality scores (quality, readerImportance, ...)
  4. Temporal (lastEdited, update_frequency, ...)
  5. Summaries (llmSummary, structuredSummary)
  6. Ratings block
  7. Collections (clusters, roles, todos, ...)
  8. Unknown fields (alphabetical)

${colors.bold}Usage:${colors.reset}
  crux fix frontmatter-order              Preview changes (dry run)
  crux fix frontmatter-order --apply      Apply changes to files
  crux fix frontmatter-order --verbose    Show reordering details
  crux fix frontmatter-order --file=path  Fix single file only
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Frontmatter block parsing (line-based, preserves formatting)
// ---------------------------------------------------------------------------

interface FrontmatterBlock {
  /** Lines before the opening --- (should be empty for valid frontmatter) */
  prefix: string[];
  /** The opening --- line */
  openDelimiter: string;
  /** Groups of lines, keyed by top-level field name */
  fields: { key: string; lines: string[] }[];
  /** The closing --- line */
  closeDelimiter: string;
  /** Everything after the closing --- */
  body: string;
}

/**
 * Parse a file's content into frontmatter field groups.
 *
 * Each "field group" is a top-level YAML key plus all its continuation lines
 * (indented lines for nested objects/arrays, multi-line strings, etc.).
 *
 * A line is a "top-level key" if it matches /^[a-zA-Z_][\w]*:/ (starts at
 * column 0, word characters, followed by colon).
 */
function parseFrontmatterBlocks(content: string): FrontmatterBlock | null {
  const lines = content.split('\n');

  // Find opening ---
  if (lines[0] !== '---') return null;

  // Find closing ---
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) return null;

  const fmLines = lines.slice(1, closeIndex);
  const fields: { key: string; lines: string[] }[] = [];
  let current: { key: string; lines: string[] } | null = null;

  for (const line of fmLines) {
    // Top-level key: starts at column 0, has a colon
    const keyMatch = line.match(/^([a-zA-Z_][\w]*):/);
    if (keyMatch) {
      if (current) fields.push(current);
      current = { key: keyMatch[1], lines: [line] };
    } else if (current) {
      // Continuation line (indented, blank, or comment within a block)
      current.lines.push(line);
    } else {
      // Leading comment or blank line before any field — attach to a pseudo-field
      if (!current) {
        current = { key: '', lines: [line] };
      }
    }
  }
  if (current) fields.push(current);

  return {
    prefix: [],
    openDelimiter: lines[0],
    fields,
    closeDelimiter: lines[closeIndex],
    body: lines.slice(closeIndex + 1).join('\n'),
  };
}

/**
 * Reassemble a FrontmatterBlock back into file content.
 */
function reassemble(block: FrontmatterBlock): string {
  const fmLines: string[] = [];
  for (const field of block.fields) {
    fmLines.push(...field.lines);
  }

  return [
    block.openDelimiter,
    ...fmLines,
    block.closeDelimiter,
  ].join('\n') + '\n' + block.body;
}

/**
 * Sort frontmatter fields by canonical order.
 * Returns a new fields array (does not mutate the original).
 */
function sortFrontmatterFields(
  fields: { key: string; lines: string[] }[],
): { key: string; lines: string[] }[] {
  // Separate leading comments/blanks (empty key) from real fields
  const leading = fields.filter(f => f.key === '');
  const real = fields.filter(f => f.key !== '');

  const sorted = [...real].sort((a, b) => {
    const aIdx = getFieldSortIndex(a.key);
    const bIdx = getFieldSortIndex(b.key);
    if (aIdx !== bIdx) return aIdx - bIdx;
    return a.key.localeCompare(b.key);
  });

  return [...leading, ...sorted];
}

// ---------------------------------------------------------------------------
// Main processing
// ---------------------------------------------------------------------------

interface FixResult {
  filePath: string;
  fieldsReordered: number;
  fieldsMoved: string[];
}

function processFile(filePath: string): FixResult | null {
  const content = readFileSync(filePath, 'utf-8');
  const block = parseFrontmatterBlocks(content);

  if (!block || block.fields.length < 2) return null;

  const sorted = sortFrontmatterFields(block.fields);

  // Check if order actually changed
  const originalKeys = block.fields.map(f => f.key);
  const sortedKeys = sorted.map(f => f.key);

  if (originalKeys.join(',') === sortedKeys.join(',')) return null;

  // Compute which fields moved
  const fieldsMoved: string[] = [];
  for (let i = 0; i < originalKeys.length; i++) {
    if (originalKeys[i] !== sortedKeys[i]) {
      fieldsMoved.push(originalKeys[i] || '(comment)');
    }
  }

  const newBlock = { ...block, fields: sorted };
  const newContent = reassemble(newBlock);

  if (newContent === content) return null;

  if (APPLY_MODE) {
    writeFileSync(filePath, newContent);
  }

  return {
    filePath,
    fieldsReordered: fieldsMoved.length,
    fieldsMoved: [...new Set(fieldsMoved)],
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const files = SINGLE_FILE ? [SINGLE_FILE] : findMdxFiles(CONTENT_DIR);
const results: FixResult[] = [];

for (const file of files) {
  const result = processFile(file);
  if (result) {
    results.push(result);
  }
}

// Output
if (results.length === 0) {
  console.log(`${colors.green}✓ All frontmatter fields are in canonical order.${colors.reset}`);
  process.exit(0);
}

console.log(`\n${colors.bold}Frontmatter Field Order Fix${colors.reset}\n`);

for (const result of results) {
  const relPath = formatPath(result.filePath);
  const icon = APPLY_MODE ? `${colors.green}✓${colors.reset}` : `${colors.yellow}~${colors.reset}`;
  const prefix = APPLY_MODE ? '' : 'would: ';
  console.log(`  ${icon} ${relPath}: ${prefix}reorder ${result.fieldsReordered} fields`);

  if (VERBOSE && result.fieldsMoved.length > 0) {
    console.log(`    ${colors.dim}Moved: ${result.fieldsMoved.join(', ')}${colors.reset}`);
  }
}

console.log(`\n${colors.bold}Summary:${colors.reset}`);
console.log(`  Files affected: ${results.length}`);
console.log(`  Total fields reordered: ${results.reduce((s, r) => s + r.fieldsReordered, 0)}`);

if (!APPLY_MODE) {
  console.log(`\n${colors.yellow}Dry run — no files modified. Use --apply to apply changes.${colors.reset}`);
} else if (results.length > 0) {
  logBulkFixes(
    results.map(r => r.filePath),
    {
      tool: 'crux-fix',
      agency: 'automated',
      note: 'Reordered frontmatter fields to canonical order (issue #398)',
    },
  );
}
