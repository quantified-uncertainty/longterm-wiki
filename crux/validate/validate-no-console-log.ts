#!/usr/bin/env node

/**
 * Validate that server-side code uses pino logger instead of console.log/info/debug.
 *
 * After the migration from console.log to pino structured logging, this check
 * prevents regressions by scanning wiki-server and groundskeeper source files
 * for banned console methods.
 *
 * Scoped to:
 *   - apps/wiki-server/src/**\/*.ts
 *   - apps/groundskeeper/src/**\/*.ts
 *
 * Excluded:
 *   - Test files (__tests__/, *.test.ts)
 *   - Commented-out lines (// console.log)
 *
 * Allowed:
 *   - console.error, console.warn (sometimes needed for fatal/startup errors)
 *
 * Usage: npx tsx crux/validate/validate-no-console-log.ts
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';

/** Directories to scan (relative to PROJECT_ROOT) */
const SCAN_DIRS = [
  'apps/wiki-server/src',
  'apps/groundskeeper/src',
];

/** Banned console methods */
const BANNED_METHODS = ['log', 'info', 'debug'] as const;
const BANNED_PATTERN = new RegExp(
  `\\bconsole\\.(${BANNED_METHODS.join('|')})\\s*\\(`,
);

interface Violation {
  file: string;
  line: number;
  text: string;
  method: string;
}

/** Recursively collect .ts files, excluding tests */
function collectTsFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(current: string): void {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        // Skip test directories
        if (entry === '__tests__' || entry === 'node_modules') continue;
        walk(fullPath);
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

function checkFile(filePath: string): Violation[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const violations: Violation[] = [];
  const relPath = relative(PROJECT_ROOT, filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Skip commented-out lines
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue;
    }

    const match = trimmed.match(BANNED_PATTERN);
    if (match) {
      violations.push({
        file: relPath,
        line: i + 1,
        text: trimmed,
        method: match[0],
      });
    }
  }

  return violations;
}

export function runCheck(): { passed: boolean; errors: number; violations: Violation[] } {
  const c = getColors();
  console.log(`${c.blue}Checking for console.log/info/debug in server code...${c.reset}\n`);

  const allFiles: string[] = [];

  for (const dir of SCAN_DIRS) {
    const absDir = join(PROJECT_ROOT, dir);
    const files = collectTsFiles(absDir);
    allFiles.push(...files);
  }

  if (allFiles.length === 0) {
    console.log(`${c.dim}No files found to check${c.reset}`);
    return { passed: true, errors: 0, violations: [] };
  }

  const allViolations: Violation[] = [];

  for (const file of allFiles) {
    const violations = checkFile(file);
    allViolations.push(...violations);
  }

  if (allViolations.length === 0) {
    console.log(`${c.green}No console.log/info/debug calls found (${allFiles.length} files checked)${c.reset}`);
  } else {
    console.log(`${c.red}Found ${allViolations.length} console.log/info/debug call(s):${c.reset}\n`);
    for (const v of allViolations) {
      console.log(`  ${c.red}${v.file}:${v.line}${c.reset}`);
      console.log(`    ${c.dim}${v.text}${c.reset}`);
      console.log(`    ${c.dim}Fix: use pino logger instead (import { logger } from "./logger.js")${c.reset}\n`);
    }
  }

  return { passed: allViolations.length === 0, errors: allViolations.length, violations: allViolations };
}

if (process.argv[1]?.includes('validate-no-console-log')) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
