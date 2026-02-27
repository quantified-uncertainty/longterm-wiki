#!/usr/bin/env node

/**
 * Validate that wiki-server routes don't use `(r: any)` casts for row results.
 *
 * Raw SQL queries should use typed row interfaces instead of casting to `any`,
 * which hides type errors and makes refactoring unsafe. This check scans route
 * files for the pattern and fails if any are found.
 *
 * Usage: npx tsx crux/validate/validate-untyped-rows.ts
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { getColors } from '../lib/output.ts';

const ROUTES_DIR = 'apps/wiki-server/src/routes';

interface Violation {
  file: string;
  line: number;
  text: string;
}

function checkFile(filePath: string): Violation[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const violations: Violation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match (r: any), (row: any), (rows: any), etc. — any single-letter or
    // common variable name followed by `: any` inside parens
    if (/\(\s*\w+\s*:\s*any\s*\)/.test(line)) {
      violations.push({
        file: filePath,
        line: i + 1,
        text: line.trim(),
      });
    }
  }

  return violations;
}

export function runCheck(): { passed: boolean; errors: number; violations: Violation[] } {
  const c = getColors();
  console.log(`${c.blue}Checking for untyped row casts in wiki-server routes...${c.reset}\n`);

  let files: string[];
  try {
    files = readdirSync(ROUTES_DIR)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => join(ROUTES_DIR, f));
  } catch {
    console.log(`${c.dim}Skipping: ${ROUTES_DIR} not found${c.reset}`);
    return { passed: true, errors: 0, violations: [] };
  }

  const allViolations: Violation[] = [];

  for (const file of files) {
    const violations = checkFile(file);
    allViolations.push(...violations);
  }

  if (allViolations.length === 0) {
    console.log(`${c.green}No untyped row casts found (${files.length} files checked)${c.reset}`);
  } else {
    console.log(`${c.red}Found ${allViolations.length} untyped row cast(s):${c.reset}\n`);
    for (const v of allViolations) {
      console.log(`  ${c.red}${v.file}:${v.line}${c.reset}`);
      console.log(`    ${c.dim}${v.text}${c.reset}`);
      console.log(`    ${c.dim}Fix: define a typed row interface instead of using (r: any)${c.reset}\n`);
    }
  }

  return { passed: allViolations.length === 0, errors: allViolations.length, violations: allViolations };
}

if (process.argv[1]?.includes('validate-untyped-rows')) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
