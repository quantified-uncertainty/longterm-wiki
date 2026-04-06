#!/usr/bin/env node

/**
 * Validate that FactBase lookups use stableIds (sid_ prefix), not raw slugs.
 *
 * The pattern `getKBLatest("anthropic", ...)` is vulnerable: it depends on
 * resolveEntityKey() loading database.json to map slugs → stableIds.
 * During Vercel ISR, this mapping can fail, causing silent data loss.
 *
 * Safe patterns:
 *   - `getKBLatest("sid_mK9pX3rQ7n", ...)` — stableId, always resolves
 *   - `getKBLatest(entity.id, ...)` — variable from entity lookup (safe if entity loaded)
 *   - `getKBLatest(entityId, ...)` — variable (safe)
 *   - `// factbase-slug-ok` suppression comment on the same line
 *
 * Scanned directories: apps/web/src/components/, apps/web/src/app/
 * Skips: test files, __tests__ directories
 *
 * Usage: npx tsx crux/validate/validate-factbase-stableid.ts
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';

const SCAN_DIRS = [
  join(PROJECT_ROOT, 'apps/web/src/components'),
  join(PROJECT_ROOT, 'apps/web/src/app'),
];

const SUPPRESS_COMMENT = 'factbase-slug-ok';

/**
 * Detect calls like getKBLatest("someSlug", ...) or getFactBaseFacts("someSlug", ...)
 * where the first argument is a hardcoded string that does NOT start with "sid_".
 *
 * Matches: getKBLatest("anthropic", ...) or getFactBaseRecords("anthropic", ...)
 * Skips:   getKBLatest("sid_abc123", ...) or getKBLatest(entity.id, ...)
 */
const FACTBASE_CALL_PATTERN =
  /(?:getKBLatest|getKBFacts|getKBRecords|getFactBaseLatest|getFactBaseFacts|getFactBaseRecords)\(\s*(['"])(?!sid_)([^'"]+)\1/;

interface Violation {
  file: string;
  line: number;
  text: string;
  reason: string;
}

function collectTsxFiles(dir: string): string[] {
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
      } else if (
        (entry.endsWith('.ts') || entry.endsWith('.tsx')) &&
        !entry.endsWith('.test.ts') &&
        !entry.endsWith('.test.tsx') &&
        !entry.endsWith('.spec.ts') &&
        !entry.endsWith('.spec.tsx')
      ) {
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

    // Skip comment lines
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue;
    }

    // Skip if suppressed
    if (line.includes(SUPPRESS_COMMENT)) {
      continue;
    }

    const match = FACTBASE_CALL_PATTERN.exec(line);
    if (match) {
      const slug = match[1];
      violations.push({
        file: relPath,
        line: i + 1,
        text: trimmed,
        reason: `Hardcoded slug "${slug}" — use the sid_-prefixed stableId instead. ` +
          `Slug lookups fail during ISR if database.json isn't loaded. ` +
          `Suppress with // ${SUPPRESS_COMMENT} if this is intentional (e.g., fallback).`,
      });
    }
  }

  return violations;
}

export function runCheck(): { passed: boolean; errors: number; violations: Violation[] } {
  const c = getColors();
  console.log(`${c.blue}Checking for hardcoded slug lookups in FactBase calls...${c.reset}\n`);

  let allFiles: string[] = [];
  for (const dir of SCAN_DIRS) {
    try {
      allFiles.push(...collectTsxFiles(dir));
    } catch {
      console.log(`${c.dim}Skipping: ${dir} not found${c.reset}`);
    }
  }

  if (allFiles.length === 0) {
    console.log(`${c.dim}No files found to check${c.reset}`);
    return { passed: true, errors: 0, violations: [] };
  }

  const allViolations: Violation[] = [];
  for (const file of allFiles) {
    allViolations.push(...checkFile(file));
  }

  if (allViolations.length === 0) {
    console.log(`${c.green}No hardcoded slug lookups found (${allFiles.length} files checked)${c.reset}`);
  } else {
    console.log(`${c.red}Found ${allViolations.length} hardcoded slug lookup(s):${c.reset}\n`);
    for (const v of allViolations) {
      console.log(`  ${c.red}${v.file}:${v.line}${c.reset}`);
      console.log(`    ${c.dim}${v.text}${c.reset}`);
      console.log(`    ${c.dim}Fix: ${v.reason}${c.reset}\n`);
    }
  }

  return { passed: allViolations.length === 0, errors: allViolations.length, violations: allViolations };
}

if (process.argv[1]?.includes('validate-factbase-stableid')) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
