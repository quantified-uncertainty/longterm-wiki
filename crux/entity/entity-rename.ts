#!/usr/bin/env node

/**
 * Entity ID Rename Tool
 *
 * Safely renames entity IDs across all MDX and YAML files using
 * word-boundary regex so short IDs like E6 don't accidentally match
 * E60, E64, etc. (the "replace_all partial match" bug from issue #147).
 *
 * Usage:
 *   pnpm crux entity rename <old-id> <new-id>           # Preview
 *   pnpm crux entity rename <old-id> <new-id> --apply   # Apply
 *   pnpm crux entity rename <old-id> <new-id> --verbose # Show context
 *
 * Examples:
 *   pnpm crux entity rename E6 ai-control          # Numeric → slug
 *   pnpm crux entity rename old-slug new-slug      # Slug → slug
 *   pnpm crux entity rename E6 E999               # Numeric → numeric
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, relative } from 'path';
import { PROJECT_ROOT, CONTENT_DIR_ABS, DATA_DIR_ABS } from '../lib/content-types.ts';
import { findFiles, findMdxFiles } from '../lib/file-utils.ts';
import { getColors } from '../lib/output.ts';

const colors = getColors();

// ---------------------------------------------------------------------------
// Core rename logic (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Escape a string for use in a RegExp.
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a word-boundary regex for an entity ID.
 *
 * Why \b works here:
 *   - E6  in  id="E6"   → boundary after 6 (next char `"` is non-word) ✓
 *   - E6  in  id="E64"  → no boundary after 6 (next char `4` is word)  ✗ (no match)
 *   - E6  in  `E6:`     → boundary after 6 (next char `:` is non-word) ✓
 *
 * JavaScript \b considers digits (\d) as word characters, so this works
 * correctly for both numeric IDs (E6) and slug IDs (ai-control).
 *
 * Note: hyphens in slug IDs are NOT word characters, so \b sits at each
 * hyphen boundary too — but that's fine since we match the full slug string.
 */
export function buildIdRegex(id: string): RegExp {
  return new RegExp(`\\b${escapeRegex(id)}\\b`, 'g');
}

export interface RenameMatch {
  lineNumber: number;
  lineContent: string;
  before: string;
  after: string;
}

export interface RenameFileResult {
  filePath: string;
  relativePath: string;
  changed: boolean;
  matchCount: number;
  matches: RenameMatch[];
  newContent: string;
}

/**
 * Apply rename to a single file's content.
 * Returns match info and the updated content.
 */
export function renameInContent(
  content: string,
  oldId: string,
  newId: string,
  filePath: string,
): RenameFileResult {
  const re = buildIdRegex(oldId);
  const lines = content.split('\n');
  const matches: RenameMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    re.lastIndex = 0; // reset for each line since we use /g
    if (re.test(line)) {
      const newLine = line.replace(buildIdRegex(oldId), newId);
      matches.push({
        lineNumber: i + 1,
        lineContent: line,
        before: line,
        after: newLine,
      });
    }
  }

  const newContent = content.replace(buildIdRegex(oldId), newId);
  const changed = newContent !== content;

  return {
    filePath,
    relativePath: relative(PROJECT_ROOT, filePath),
    changed,
    matchCount: matches.length,
    matches,
    newContent,
  };
}

// ---------------------------------------------------------------------------
// File scanning
// ---------------------------------------------------------------------------

/**
 * Find all files that should be scanned for entity ID references.
 * - MDX files in content/docs/
 * - YAML files in data/ (entities, facts, resources, etc.)
 */
export function findScanTargets(root: string = PROJECT_ROOT): string[] {
  const mdxFiles = findMdxFiles(join(root, 'content', 'docs'));
  const yamlFiles = findFiles(join(root, 'data'), ['.yaml', '.yml']);
  return [...mdxFiles, ...yamlFiles];
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

interface RenameOptions {
  apply: boolean;
  verbose: boolean;
  root: string;
}

export async function runRename(
  oldId: string,
  newId: string,
  opts: Partial<RenameOptions> = {},
): Promise<{ exitCode: number; output: string }> {
  const { apply = false, verbose = false, root = PROJECT_ROOT } = opts;

  if (!oldId || !newId) {
    return {
      exitCode: 1,
      output: 'Usage: crux entity rename <old-id> <new-id> [--apply] [--verbose]',
    };
  }

  if (oldId === newId) {
    return { exitCode: 1, output: `Error: old-id and new-id are the same: "${oldId}"` };
  }

  const files = findScanTargets(root);
  const results: RenameFileResult[] = [];

  for (const filePath of files) {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const result = renameInContent(content, oldId, newId, filePath);
    if (result.changed) {
      results.push(result);
    }
  }

  const lines: string[] = [];

  if (results.length === 0) {
    lines.push(
      `${colors.yellow}No occurrences of "${oldId}" found in ${files.length} files.${colors.reset}`,
    );
    return { exitCode: 0, output: lines.join('\n') };
  }

  const totalMatches = results.reduce((sum, r) => sum + r.matchCount, 0);
  const mode = apply ? 'Applying' : 'Preview';

  lines.push(
    `${colors.bold}${mode}: rename "${oldId}" → "${newId}" (${totalMatches} occurrences in ${results.length} files)${colors.reset}`,
  );

  for (const result of results) {
    lines.push(`\n  ${colors.cyan}${result.relativePath}${colors.reset} (${result.matchCount} match${result.matchCount !== 1 ? 'es' : ''})`);
    if (verbose) {
      for (const match of result.matches) {
        lines.push(`    L${match.lineNumber}: ${colors.dim}${match.before.trim()}${colors.reset}`);
        lines.push(`         → ${match.after.trim()}`);
      }
    }
    if (apply) {
      writeFileSync(result.filePath, result.newContent, 'utf-8');
    }
  }

  if (!apply) {
    lines.push(
      `\n${colors.yellow}Dry run — no files changed. Use --apply to apply.${colors.reset}`,
    );
  } else {
    lines.push(
      `\n${colors.green}✓ Updated ${results.length} file${results.length !== 1 ? 's' : ''}.${colors.reset}`,
    );
  }

  return { exitCode: 0, output: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// Script entry point (when run directly)
// ---------------------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const hasApply = args.includes('--apply');
  const hasVerbose = args.includes('--verbose');

  if (positional.length < 2 || args.includes('--help')) {
    console.log(`Usage: crux entity rename <old-id> <new-id> [--apply] [--verbose]

  Safely renames entity IDs across all MDX and YAML files.
  Uses word-boundary matching so "E6" never matches "E64".

Options:
  --apply     Apply changes (default: dry-run preview)
  --verbose   Show each matching line and its replacement
  --help      Show this help

Examples:
  pnpm crux entity rename E6 ai-control           # Preview
  pnpm crux entity rename E6 ai-control --apply   # Apply
  pnpm crux entity rename old-slug new-slug --apply --verbose`);
    process.exit(positional.length < 2 ? 1 : 0);
  }

  const [oldId, newId] = positional;
  const result = await runRename(oldId, newId, { apply: hasApply, verbose: hasVerbose });
  console.log(result.output);
  process.exit(result.exitCode);
}
