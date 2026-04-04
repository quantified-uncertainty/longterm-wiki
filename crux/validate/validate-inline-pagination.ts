#!/usr/bin/env node

/**
 * Validate that wiki-server routes don't use raw inline limit clamping.
 *
 * The pattern `Math.min(Number(c.req.query("limit")` (or similar) is the old
 * approach before `clampedLimit()` was introduced in apps/wiki-server/src/routes/shared/utils.ts.
 * Using it directly bypasses the shared utility and produces inconsistent clamping behaviour.
 *
 * Also checks for `.limit(Number(` and `.limit(parseInt(` which would pass a raw unvalidated
 * limit directly to the DB query instead of going through Zod validation with `clampedLimit`.
 *
 * Allowed patterns:
 *   - `clampedLimit(...)` — shared utility from routes/shared/utils.ts
 *   - `paginationQuery(...)` — wraps clampedLimit internally
 *   - Hardcoded literals like `.limit(1)` or `.limit(50)` — not user-controlled
 *   - `// pagination-ok` suppression comment on the same line
 *
 * Scanned directory: apps/wiki-server/src/routes/
 *
 * Suppression: add `// pagination-ok` on the same line.
 *
 * Usage: npx tsx crux/validate/validate-inline-pagination.ts
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';

const ROUTES_DIR = join(PROJECT_ROOT, 'apps/wiki-server/src/routes');

/** Suppression comment */
const SUPPRESS_COMMENT = 'pagination-ok';

/**
 * Patterns that indicate unsafe inline limit handling.
 * Each has an explanation for the fix message.
 */
const VIOLATION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    // Old style: Math.min(Number(c.req.query("limit") ...), maxLimit)
    pattern: /Math\.min\(Number\(c\.req\.(?:query|param)\(/,
    reason: 'Use zv("query", schema) with clampedLimit(max, default) in a Zod schema instead',
  },
  {
    // Old style: .limit(Number( — passes raw converted number directly to DB
    pattern: /\.limit\(Number\(/,
    reason: 'Use clampedLimit(max, default) in a Zod query schema to validate and clamp the limit',
  },
  {
    // Old style: .limit(parseInt( — same problem
    pattern: /\.limit\(parseInt\(/,
    reason: 'Use clampedLimit(max, default) in a Zod query schema to validate and clamp the limit',
  },
];

interface Violation {
  file: string;
  line: number;
  text: string;
  reason: string;
}

/** Recursively collect .ts files, excluding tests and node_modules */
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

/** Check a single line for violations. Exported for testing. */
export function checkLine(line: string): { violation: boolean; reason?: string } {
  const trimmed = line.trimStart();

  // Skip comment lines
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
    return { violation: false };
  }

  // Skip if suppressed
  if (line.includes(SUPPRESS_COMMENT)) {
    return { violation: false };
  }

  for (const { pattern, reason } of VIOLATION_PATTERNS) {
    if (pattern.test(line)) {
      return { violation: true, reason };
    }
  }

  return { violation: false };
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

    // Skip if suppressed
    if (line.includes(SUPPRESS_COMMENT)) continue;

    for (const { pattern, reason } of VIOLATION_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({
          file: relPath,
          line: i + 1,
          text: trimmed,
          reason,
        });
        break; // Only report one violation per line
      }
    }
  }

  return violations;
}

export function runCheck(): { passed: boolean; errors: number; violations: Violation[] } {
  const c = getColors();
  console.log(`${c.blue}Checking for inline limit clamping patterns in wiki-server routes...${c.reset}\n`);

  let allFiles: string[];
  try {
    allFiles = collectTsFiles(ROUTES_DIR);
  } catch {
    console.log(`${c.dim}Skipping: ${ROUTES_DIR} not found${c.reset}`);
    return { passed: true, errors: 0, violations: [] };
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
    console.log(`${c.green}No inline limit clamping found (${allFiles.length} files checked)${c.reset}`);
  } else {
    console.log(`${c.red}Found ${allViolations.length} inline limit clamping pattern(s):${c.reset}\n`);
    for (const v of allViolations) {
      console.log(`  ${c.red}${v.file}:${v.line}${c.reset}`);
      console.log(`    ${c.dim}${v.text}${c.reset}`);
      console.log(`    ${c.dim}Fix: ${v.reason}${c.reset}`);
      console.log(`    ${c.dim}See apps/wiki-server/src/routes/shared/utils.ts for clampedLimit() and paginationQuery()${c.reset}\n`);
    }
  }

  return { passed: allViolations.length === 0, errors: allViolations.length, violations: allViolations };
}

if (process.argv[1]?.includes('validate-inline-pagination')) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
