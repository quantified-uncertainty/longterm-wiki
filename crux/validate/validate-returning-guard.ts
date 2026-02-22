#!/usr/bin/env node

/**
 * Validate that `.returning()` results are accessed safely.
 *
 * Scans wiki-server route files for patterns where a `.returning()` result
 * is accessed via `[0]` without either:
 *   - Being wrapped in `firstOrThrow()`
 *   - Having a prior `.length` check
 *
 * This prevents silent crashes when INSERT/UPDATE returns zero rows
 * (race conditions, constraint violations, etc.).
 *
 * Usage: npx tsx crux/validate/validate-returning-guard.ts
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { getColors } from '../lib/output.ts';

const ROUTES_DIR = 'apps/wiki-server/src/routes';

interface Violation {
  file: string;
  line: number;
  variable: string;
  text: string;
}

/**
 * Find all `.returning()` assignments and check if `[0]` accesses are guarded.
 */
function checkFile(filePath: string): Violation[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const violations: Violation[] = [];

  // Track variables assigned from .returning()
  // Pattern: `const <name> = await <expr>.returning();` or similar
  const returningAssignments: Array<{ varName: string; line: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match variable assignments that precede a .returning() chain
    // e.g., `const rows = await db.insert(...).values(...).returning();`
    // The variable name is often on a line like `const rows = await db` or `const rows = await tx`
    // and `.returning()` is several lines later.
    //
    // Strategy: find `.returning()` lines and look backwards for the variable name.
    if (line.includes('.returning(')) {
      // Look backwards to find the assignment
      for (let j = i; j >= Math.max(0, i - 15); j--) {
        const assignMatch = lines[j].match(/\b(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?/);
        if (assignMatch) {
          returningAssignments.push({ varName: assignMatch[1], line: i + 1 });
          break;
        }
      }
    }
  }

  // Deduplicate: if multiple .returning() assignments use the same variable name,
  // only check the window from each assignment to the next one.
  const seen = new Set<number>();

  for (let idx = 0; idx < returningAssignments.length; idx++) {
    const { varName, line: returningLine } = returningAssignments[idx];

    // Determine scan window: from this .returning() to the next .returning() or +20 lines
    const nextReturningLine = idx + 1 < returningAssignments.length
      ? returningAssignments[idx + 1].line
      : returningLine + 20;
    const scanEnd = Math.min(lines.length, nextReturningLine);

    for (let i = returningLine; i < scanEnd; i++) {
      const line = lines[i];

      // Check for [0] access on this variable
      if (!line.includes(`${varName}[0]`)) continue;

      // Deduplicate by line number
      if (seen.has(i + 1)) continue;

      // Check if wrapped in firstOrThrow()
      if (line.includes('firstOrThrow(')) continue;

      // Check if there's a .length check between .returning() and this line
      let hasLengthCheck = false;
      for (let j = returningLine; j < i; j++) {
        if (lines[j].includes(`${varName}.length`)) {
          hasLengthCheck = true;
          break;
        }
      }
      if (hasLengthCheck) continue;

      seen.add(i + 1);
      violations.push({
        file: filePath,
        line: i + 1,
        variable: varName,
        text: line.trim(),
      });
    }
  }

  return violations;
}

export function runCheck(): { passed: boolean; errors: number; violations: Violation[] } {
  const c = getColors();
  console.log(`${c.blue}Checking .returning() guard patterns in wiki-server routes...${c.reset}\n`);

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
    console.log(`${c.green}All .returning() results are safely guarded (${files.length} files checked)${c.reset}`);
  } else {
    console.log(`${c.red}Found ${allViolations.length} unguarded .returning()[0] access(es):${c.reset}\n`);
    for (const v of allViolations) {
      console.log(`  ${c.red}${v.file}:${v.line}${c.reset}`);
      console.log(`    Variable: ${v.variable}`);
      console.log(`    ${c.dim}${v.text}${c.reset}`);
      console.log(`    ${c.dim}Fix: use firstOrThrow(${v.variable}, "context") or add a .length check${c.reset}\n`);
    }
  }

  return { passed: allViolations.length === 0, errors: allViolations.length, violations: allViolations };
}

if (process.argv[1]?.includes('validate-returning-guard')) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
