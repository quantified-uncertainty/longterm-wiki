#!/usr/bin/env node

/**
 * Orphaned Footnotes Remover
 *
 * Scans MDX files for footnote definitions (e.g. [^7]: Some text) where the
 * corresponding reference [^7] never appears in the body text. Removes the
 * orphaned definition lines and any continuation lines, then cleans up
 * consecutive blank lines.
 *
 * Usage:
 *   pnpm crux fix orphaned-footnotes              # Preview changes (dry run)
 *   pnpm crux fix orphaned-footnotes --apply      # Apply changes
 *   pnpm crux fix orphaned-footnotes --verbose    # Show removed footnotes
 *   pnpm crux fix orphaned-footnotes --file=path  # Fix single file only
 *
 * See issue #1216.
 */

import { readFileSync, writeFileSync } from 'fs';
import { relative } from 'path';
import { findMdxFiles } from '../lib/file-utils.ts';
import { getColors, formatPath } from '../lib/output.ts';
import { CONTENT_DIR_ABS as CONTENT_DIR } from '../lib/content-types.ts';
import { parseFrontmatterAndBody } from '../lib/mdx-utils.ts';
import { logBulkFixes } from '../lib/session/edit-log.ts';

const args: string[] = process.argv.slice(2);
const APPLY_MODE: boolean = args.includes('--apply');
const VERBOSE: boolean = args.includes('--verbose');
const HELP: boolean = args.includes('--help');
const SINGLE_FILE: string | undefined = args.find(a => a.startsWith('--file='))?.split('=')[1];

const colors = getColors();

if (HELP) {
  console.log(`
${colors.bold}Orphaned Footnotes Remover${colors.reset}

Removes footnote definitions that have no matching inline reference in the body.

${colors.bold}Usage:${colors.reset}
  crux fix orphaned-footnotes              Preview changes (dry run)
  crux fix orphaned-footnotes --apply      Apply changes to files
  crux fix orphaned-footnotes --verbose    Show removed footnotes
  crux fix orphaned-footnotes --file=path  Fix single file only

${colors.bold}What it removes:${colors.reset}
  - Footnote definitions like [^7]: text where [^7] is never used
  - Multi-line footnote definitions (definition + indented continuations)
  - Consecutive blank lines left after removal
`);
  process.exit(0);
}

/** Matches a footnote definition line: [^MARKER]: text */
const DEF_RE = /^\[\^([^\]]+)\]:\s?/;

/** Matches an inline footnote reference [^MARKER] (not a definition). */
const INLINE_REF_RE = /\[\^([^\]]+)\](?!:)/g;

interface OrphanedFootnote {
  marker: string;
  lineIndices: number[];
  text: string;
}

interface RemovalResult {
  filePath: string;
  orphans: OrphanedFootnote[];
}

/**
 * Find orphaned footnotes in a content body.
 * Returns the list of orphaned footnotes with their line positions.
 */
function findOrphanedFootnotes(body: string): OrphanedFootnote[] {
  const lines = body.split('\n');
  let inCodeFence = false;

  const inlineRefs = new Set<string>();
  const definitions: Array<{ marker: string; lineIndex: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim().startsWith('```') || line.trim().startsWith('~~~')) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    // Check if this line is a footnote definition
    const defMatch = DEF_RE.exec(line);
    if (defMatch) {
      definitions.push({ marker: defMatch[1], lineIndex: i });
      // Also check the definition line itself for inline refs to OTHER footnotes
      // (a definition line like [^7]: See also [^3] should count [^3] as referenced)
      INLINE_REF_RE.lastIndex = 0;
      const afterDef = line.replace(DEF_RE, '');
      let refMatch: RegExpExecArray | null;
      while ((refMatch = INLINE_REF_RE.exec(afterDef)) !== null) {
        inlineRefs.add(refMatch[1]);
      }
      continue;
    }

    // Collect inline references from non-definition lines
    INLINE_REF_RE.lastIndex = 0;
    let refMatch: RegExpExecArray | null;
    while ((refMatch = INLINE_REF_RE.exec(line)) !== null) {
      inlineRefs.add(refMatch[1]);
    }
  }

  const orphans: OrphanedFootnote[] = [];

  for (const { marker, lineIndex } of definitions) {
    if (inlineRefs.has(marker)) continue;

    // Find all lines belonging to this definition
    const defLines: number[] = [lineIndex];
    for (let j = lineIndex + 1; j < lines.length; j++) {
      const nextLine = lines[j];
      // Continuation: indented non-empty line
      if (/^\s+\S/.test(nextLine)) {
        defLines.push(j);
        continue;
      }
      // Blank line inside multi-line footnote: only if next non-blank is indented
      if (nextLine === '') {
        let k = j + 1;
        while (k < lines.length && lines[k] === '') k++;
        if (k < lines.length && /^\s+\S/.test(lines[k])) {
          defLines.push(j);
          continue;
        }
      }
      break;
    }

    const text = defLines.map(i => lines[i]).join('\n');
    orphans.push({ marker, lineIndices: defLines, text });
  }

  return orphans;
}

/**
 * Remove orphaned footnotes from content and clean up blank lines.
 */
function removeOrphanedFootnotes(content: string): { newContent: string; orphans: OrphanedFootnote[] } {
  const { body } = parseFrontmatterAndBody(content);
  const orphans = findOrphanedFootnotes(body);

  if (orphans.length === 0) {
    return { newContent: content, orphans: [] };
  }

  // Collect all line indices to remove (in the body)
  const linesToRemove = new Set<number>();
  for (const orphan of orphans) {
    for (const idx of orphan.lineIndices) {
      linesToRemove.add(idx);
    }
  }

  // Split content into frontmatter + body, rebuild body without orphaned lines
  const allLines = content.split('\n');

  // Find where the body starts (after frontmatter)
  let bodyStartLine = 0;
  if (allLines[0] === '---') {
    let dashCount = 0;
    for (let i = 0; i < allLines.length; i++) {
      if (allLines[i] === '---') {
        dashCount++;
        if (dashCount === 2) {
          bodyStartLine = i + 1;
          break;
        }
      }
    }
  }

  // Remove orphaned lines (convert body line indices to absolute indices)
  const filteredLines: string[] = [];
  for (let i = 0; i < allLines.length; i++) {
    const bodyLineIndex = i - bodyStartLine;
    if (bodyLineIndex >= 0 && linesToRemove.has(bodyLineIndex)) {
      continue; // Skip this line entirely
    }
    filteredLines.push(allLines[i]);
  }

  // Clean up consecutive blank lines (max 2 consecutive newlines)
  let newContent = filteredLines.join('\n');
  newContent = newContent.replace(/\n{3,}/g, '\n\n');
  // Ensure file ends with exactly one newline
  newContent = newContent.replace(/\n{2,}$/g, '\n');
  if (!newContent.endsWith('\n')) {
    newContent += '\n';
  }

  return { newContent, orphans };
}

function processFile(filePath: string): RemovalResult | null {
  // Skip internal documentation pages
  if (filePath.includes('/internal/')) return null;

  const content = readFileSync(filePath, 'utf-8');
  const { newContent, orphans } = removeOrphanedFootnotes(content);

  if (orphans.length === 0) return null;

  if (APPLY_MODE) {
    writeFileSync(filePath, newContent);
  }

  return { filePath, orphans };
}

// Main
const files = SINGLE_FILE ? [SINGLE_FILE] : findMdxFiles(CONTENT_DIR);
const results: RemovalResult[] = [];
let totalOrphans = 0;

for (const file of files) {
  const result = processFile(file);
  if (result) {
    results.push(result);
    totalOrphans += result.orphans.length;
  }
}

// Output
if (results.length === 0) {
  console.log(`${colors.green}✓ No orphaned footnotes found.${colors.reset}`);
  process.exit(0);
}

console.log(`\n${colors.bold}Orphaned Footnotes Cleanup${colors.reset}\n`);

for (const result of results) {
  const relPath = formatPath(result.filePath);
  const count = result.orphans.length;
  const markers = result.orphans.map(o => `[^${o.marker}]`).join(', ');

  const icon = APPLY_MODE ? `${colors.green}✓${colors.reset}` : `${colors.yellow}~${colors.reset}`;
  const prefix = APPLY_MODE ? 'removed' : 'would remove';
  console.log(`  ${icon} ${relPath}: ${prefix} ${count} orphaned footnote(s): ${markers}`);

  if (VERBOSE) {
    for (const orphan of result.orphans) {
      const preview = orphan.text.split('\n')[0].slice(0, 80);
      console.log(`    ${colors.dim}[^${orphan.marker}]: ${preview}${orphan.text.length > 80 ? '...' : ''}${colors.reset}`);
    }
  }
}

console.log(`\n${colors.bold}Summary:${colors.reset}`);
console.log(`  Files affected: ${results.length}`);
console.log(`  Orphaned footnotes: ${totalOrphans}`);

if (!APPLY_MODE) {
  console.log(`\n${colors.yellow}Dry run — no files modified. Use --apply to apply changes.${colors.reset}`);
} else if (results.length > 0) {
  logBulkFixes(
    results.map(r => r.filePath),
    {
      tool: 'crux-fix',
      agency: 'automated',
      note: 'Removed orphaned footnote definitions (no matching inline reference)',
    },
  );
}
