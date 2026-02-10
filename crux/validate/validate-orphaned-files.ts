#!/usr/bin/env node

/**
 * Orphaned Files Validator
 *
 * Finds files that shouldn't be in the content directory:
 * - .tmp backup files
 * - .bak files
 * - Files with ~ suffix (editor backups)
 * - .DS_Store files
 * - Empty directories
 *
 * Usage:
 *   node scripts/validate-orphaned-files.ts [options]
 *
 * Options:
 *   --ci      Output JSON for CI pipelines
 *   --fix     Delete orphaned files (use with caution!)
 *
 * Exit codes:
 *   0 = No orphaned files found
 *   1 = Orphaned files found
 */

import { existsSync, readdirSync, statSync, unlinkSync, rmdirSync } from 'fs';
import { join, basename } from 'path';
import { fileURLToPath } from 'url';
import { getColors, formatPath } from '../lib/output.ts';
import { CONTENT_DIR, DATA_DIR } from '../lib/content-types.ts';
import type { ValidatorResult, ValidatorOptions } from './types.ts';
import type { Colors } from '../lib/output.ts';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

interface OrphanedFileEntry {
  path: string;
  pattern: string;
  size: number;
  modified: string;
}

interface FindOrphanedResult {
  files: OrphanedFileEntry[];
  emptyDirs: string[];
}

interface FixResult {
  deleted: number;
  failed: number;
}

interface OrphanedResults {
  orphanedFiles: OrphanedFileEntry[];
  emptyDirs: string[];
  fixed: FixResult;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Patterns for orphaned files
const ORPHAN_PATTERNS: RegExp[] = [
  /\.tmp$/,           // .tmp files
  /\.bak$/,           // .bak files
  /~$/,               // editor backup files (file~)
  /^\.DS_Store$/,     // macOS metadata
  /\.swp$/,           // vim swap files
  /\.swo$/,           // vim swap files
  /^#.*#$/,           // emacs auto-save
  /\.orig$/,          // merge conflict originals
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively find orphaned files
 */
function findOrphanedFiles(dir: string, results: FindOrphanedResult = { files: [], emptyDirs: [] }): FindOrphanedResult {
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir);

  // Check if directory is empty (after filtering out .DS_Store)
  const realEntries = entries.filter((e: string) => e !== '.DS_Store');
  if (realEntries.length === 0) {
    results.emptyDirs.push(dir);
  }

  for (const entry of entries) {
    const filePath = join(dir, entry);
    const stat = statSync(filePath);

    if (stat.isDirectory()) {
      findOrphanedFiles(filePath, results);
    } else {
      // Check if file matches any orphan pattern
      for (const pattern of ORPHAN_PATTERNS) {
        if (pattern.test(entry)) {
          results.files.push({
            path: filePath,
            pattern: pattern.toString(),
            size: stat.size,
            modified: stat.mtime.toISOString(),
          });
          break;
        }
      }
    }
  }

  return results;
}

/**
 * Delete orphaned files if --fix flag is passed
 */
function deleteOrphanedFiles(files: OrphanedFileEntry[], ciMode: boolean, colors: Colors): FixResult {
  let deleted = 0;
  let failed = 0;

  for (const file of files) {
    try {
      unlinkSync(file.path);
      deleted++;
      if (!ciMode) {
        console.log(`${colors.green}  Deleted: ${file.path}${colors.reset}`);
      }
    } catch (err: unknown) {
      failed++;
      if (!ciMode) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`${colors.red}  Failed to delete: ${file.path} (${message})${colors.reset}`);
      }
    }
  }

  return { deleted, failed };
}

// ---------------------------------------------------------------------------
// runCheck (for orchestrator)
// ---------------------------------------------------------------------------

export function runCheck(options: ValidatorOptions = {}): ValidatorResult {
  const ciMode = options.ci ?? false;
  const fixMode = options.fix ?? false;
  const colors: Colors = getColors(ciMode);

  const results: OrphanedResults = {
    orphanedFiles: [],
    emptyDirs: [],
    fixed: { deleted: 0, failed: 0 },
  };

  if (!ciMode) {
    console.log(`${colors.blue}🗑️  Finding orphaned files...${colors.reset}\n`);
  }

  // Scan content directory
  const contentOrphans = findOrphanedFiles(CONTENT_DIR);
  results.orphanedFiles.push(...contentOrphans.files);
  results.emptyDirs.push(...contentOrphans.emptyDirs);

  // Also scan data directory
  const dataOrphans = findOrphanedFiles(DATA_DIR);
  results.orphanedFiles.push(...dataOrphans.files);
  results.emptyDirs.push(...dataOrphans.emptyDirs);

  // Handle --fix mode
  if (fixMode && results.orphanedFiles.length > 0) {
    if (!ciMode) {
      console.log(`${colors.yellow}Deleting orphaned files...${colors.reset}\n`);
    }
    results.fixed = deleteOrphanedFiles(results.orphanedFiles, ciMode, colors);
  }

  // Output results
  if (ciMode) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    if (results.orphanedFiles.length > 0) {
      console.log(`${colors.yellow}⚠️  Orphaned files found:${colors.reset}\n`);

      // Group by directory for cleaner output
      const byDir: Record<string, OrphanedFileEntry[]> = {};
      for (const file of results.orphanedFiles) {
        const dir = file.path.split('/').slice(0, -1).join('/');
        if (!byDir[dir]) byDir[dir] = [];
        byDir[dir].push(file);
      }

      for (const [dir, files] of Object.entries(byDir)) {
        console.log(`  ${colors.dim}${dir}/${colors.reset}`);
        for (const f of files) {
          const name = basename(f.path);
          const size = f.size < 1024 ? `${f.size}B` : `${(f.size / 1024).toFixed(1)}KB`;
          console.log(`    ${colors.yellow}${name}${colors.reset} ${colors.dim}(${size})${colors.reset}`);
        }
      }
      console.log();
    }

    if (results.emptyDirs.length > 0) {
      console.log(`${colors.yellow}⚠️  Empty directories:${colors.reset}\n`);
      for (const dir of results.emptyDirs) {
        console.log(`  ${dir}`);
      }
      console.log();
    }

    // Summary
    console.log(`${'─'.repeat(50)}`);
    if (results.orphanedFiles.length === 0 && results.emptyDirs.length === 0) {
      console.log(`${colors.green}✅ No orphaned files found${colors.reset}`);
    } else {
      console.log(`Orphaned files: ${results.orphanedFiles.length}`);
      console.log(`Empty dirs:     ${results.emptyDirs.length}`);

      if (fixMode) {
        console.log(`\n${colors.green}Deleted: ${results.fixed.deleted}${colors.reset}`);
        if (results.fixed.failed > 0) {
          console.log(`${colors.red}Failed:  ${results.fixed.failed}${colors.reset}`);
        }
      } else if (results.orphanedFiles.length > 0) {
        console.log(`\n${colors.dim}Run with --fix to delete orphaned files${colors.reset}`);
      }
    }
  }

  const hasIssues = results.orphanedFiles.length > 0 && !fixMode;
  return {
    passed: !hasIssues,
    errors: hasIssues ? results.orphanedFiles.length : 0,
    warnings: results.emptyDirs.length,
  };
}

// ---------------------------------------------------------------------------
// Standalone main
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const result = runCheck({
    ci: args.includes('--ci'),
    fix: args.includes('--fix'),
  });
  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
