#!/usr/bin/env node

/**
 * Validate that crux code uses typed wiki-server client functions (with InferResponseType<>)
 * instead of inline hand-written type parameters on apiRequest<{...}>.
 *
 * The pattern `apiRequest<{` means someone is passing an inline type literal instead of
 * using the typed client functions in crux/lib/wiki-server/ which infer response types
 * from the Hono RPC route definitions.
 *
 * Scoped to:
 *   - crux/**\/*.ts
 *
 * Excluded:
 *   - __tests__/, *.test.ts, node_modules/
 *   - crux/lib/wiki-server/ (these ARE the typed clients — inline types are expected there)
 *
 * Suppression: add `// api-type-ok` on the same line.
 *
 * Usage: npx tsx crux/validate/validate-manual-api-types.ts
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';

/** Directory to scan (relative to PROJECT_ROOT) */
const SCAN_DIR = 'crux';

/** Subdirectory to exclude (the typed clients themselves) */
const EXCLUDED_SUBDIR = join('crux', 'lib', 'wiki-server');

/** Pattern to detect: apiRequest<{ (inline hand-written type parameter) */
const VIOLATION_PATTERN = /apiRequest<\{/;

/** Suppression comment — must appear as `// api-type-ok` (comment-style) */
const SUPPRESS_PATTERN = /\/\/\s*api-type-ok/;

interface Violation {
  file: string;
  line: number;
  text: string;
}

/** Recursively collect .ts files, excluding tests, node_modules, and wiki-server client dir */
function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  const excludedAbsDir = join(PROJECT_ROOT, EXCLUDED_SUBDIR);

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
        if (entry === '__tests__' || entry === 'node_modules') continue;
        // Skip the typed wiki-server client directory
        if (fullPath === excludedAbsDir) continue;
        walk(fullPath);
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

/** Check a single line for violations. Exported for testing. */
export function checkLine(line: string): 'violation' | 'suppressed' | 'clean' {
  const trimmed = line.trimStart();

  // Skip comment lines
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
    return 'clean';
  }

  // Check suppression (must be a comment: // api-type-ok)
  if (SUPPRESS_PATTERN.test(line)) {
    return 'suppressed';
  }

  if (VIOLATION_PATTERN.test(trimmed)) {
    return 'violation';
  }

  return 'clean';
}

function checkFile(filePath: string): Violation[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const violations: Violation[] = [];
  const relPath = relative(PROJECT_ROOT, filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Skip comment lines
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue;
    }

    // Skip if suppressed with explicit comment syntax: // api-type-ok
    if (SUPPRESS_PATTERN.test(line)) continue;

    if (VIOLATION_PATTERN.test(trimmed)) {
      violations.push({
        file: relPath,
        line: i + 1,
        text: trimmed,
      });
    }
  }

  return violations;
}

export function runCheck(): { passed: boolean; errors: number; violations: Violation[] } {
  const c = getColors();
  console.log(`${c.blue}Checking for inline apiRequest<{...}> type parameters in crux/...${c.reset}\n`); // api-type-ok

  const absDir = join(PROJECT_ROOT, SCAN_DIR);
  const allFiles = collectTsFiles(absDir);

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
    console.log(`${c.green}No inline apiRequest type parameters found (${allFiles.length} files checked)${c.reset}`);
  } else {
    console.log(`${c.yellow}Found ${allViolations.length} inline apiRequest<{...}> type parameter(s):${c.reset}\n`); // api-type-ok
    for (const v of allViolations) {
      console.log(`  ${c.yellow}${v.file}:${v.line}${c.reset}`);
      console.log(`    ${c.dim}${v.text}${c.reset}`);
      console.log(`    ${c.dim}Fix: use typed client from crux/lib/wiki-server/ with InferResponseType<>, or add // api-type-ok${c.reset}\n`);
    }
    console.log(`${c.yellow}This check is advisory — ${allViolations.length} existing violation(s) to migrate over time.${c.reset}`);
  }

  return { passed: allViolations.length === 0, errors: allViolations.length, violations: allViolations };
}

if (process.argv[1]?.includes('validate-manual-api-types')) {
  runCheck();
  // Advisory: always exit 0, but print warnings
  process.exit(0);
}
