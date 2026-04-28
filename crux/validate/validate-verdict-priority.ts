#!/usr/bin/env node

/**
 * Validate that source-check verdict severity/priority is defined in exactly
 * one place: SOURCE_CHECK_VERDICT_PRIORITY in apps/web/src/components/shared/verdict-styles.ts.
 *
 * QUA-429 found two helpers (`pickWorstVerdict`, `rollupVerdictFromSummary`)
 * with different priority orders that swapped `outdated` and `unverifiable`,
 * causing the same record to display different verdicts on profile headers
 * vs. directory tables on the same page load.
 *
 * Detection: a file (other than the canonical source) declares an object
 * literal with verdict-name keys mapping to DISTINCT integer values within
 * a small line window. This is unambiguous "priority map" shape — Zod enums,
 * counters (all zeros), and display-orderings (arrays) don't trigger it.
 *
 *   Bad (would be flagged):
 *     const VERDICT_PRIORITY = { contradicted: 0, outdated: 1, partial: 2, ... }
 *
 *   Allowed (won't trigger):
 *     z.enum(["confirmed", "contradicted", ...])         // type union
 *     { confirmed: 0, contradicted: 0, partial: 0, ... } // counter (all 0s)
 *     ["confirmed", "partial", ...] as const             // ordering / display
 *
 * Opt-out: add `// verdict-priority-ok: <reason>` on the line before the
 * declaration if the priority is legitimately distinct from the canonical
 * severity rollup (e.g. recheck scheduling, curation order). The reason
 * makes the intent explicit for reviewers.
 *
 * Usage: npx tsx crux/validate/validate-verdict-priority.ts
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';

const SCAN_DIRS = ['apps/web/src', 'apps/wiki-server/src', 'crux'];

/** Files that legitimately define the canonical priority map. */
const ALLOWLIST = new Set<string>([
  'apps/web/src/components/shared/verdict-styles.ts',
]);

const VERDICT_NAMES = [
  'contradicted',
  'outdated',
  'partial',
  'unverifiable',
  'confirmed',
  'unchecked',
] as const;
type VerdictName = (typeof VERDICT_NAMES)[number];

interface Violation {
  file: string;
  startLine: number;
  matchedAssignments: Array<{ name: VerdictName; value: number }>;
  preview: string;
}

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
        if (entry === '__tests__' || entry === 'node_modules' || entry === '.next') continue;
        walk(fullPath);
      } else if (
        (entry.endsWith('.ts') || entry.endsWith('.tsx')) &&
        !entry.endsWith('.test.ts') &&
        !entry.endsWith('.test.tsx') &&
        !entry.endsWith('.test-d.ts')
      ) {
        results.push(fullPath);
      }
    }
  }
  walk(dir);
  return results;
}

/**
 * Match a line that maps a verdict name to an integer literal:
 *   contradicted: 0,
 *   "outdated": 1,
 *   partial: -1
 */
function matchPriorityAssignment(
  line: string,
): { name: VerdictName; value: number } | null {
  const trimmed = line.trim();
  for (const name of VERDICT_NAMES) {
    const m = new RegExp(
      `^["']?${name}["']?\\s*:\\s*(-?[0-9]+)\\s*,?\\s*(?://.*)?$`,
    ).exec(trimmed);
    if (m) {
      return { name, value: Number(m[1]) };
    }
  }
  return null;
}

/** Lines inside an unbalanced backtick template literal — skip them. */
function computeInTemplateLiteral(lines: string[]): boolean[] {
  const flags: boolean[] = [];
  let inTemplate = false;
  for (const line of lines) {
    let countAtLineStart = inTemplate;
    // Count unescaped backticks (rough — ignores ones inside string/comment
    // contexts but good enough for help-text detection).
    let i = 0;
    while (i < line.length) {
      if (line[i] === '\\') {
        i += 2;
        continue;
      }
      if (line[i] === '`') {
        inTemplate = !inTemplate;
      }
      i++;
    }
    flags.push(countAtLineStart);
  }
  return flags;
}

function checkFile(filePath: string): Violation[] {
  const relPath = relative(PROJECT_ROOT, filePath);
  if (ALLOWLIST.has(relPath)) return [];

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const inTemplate = computeInTemplateLiteral(lines);
  const violations: Violation[] = [];

  // Walk the file, looking for runs of consecutive (modulo blanks/comments)
  // priority-assignment lines for at least 3 distinct verdict names.
  let i = 0;
  while (i < lines.length) {
    if (inTemplate[i]) {
      i++;
      continue;
    }
    const first = matchPriorityAssignment(lines[i]);
    if (!first) {
      i++;
      continue;
    }
    // Look back up to 6 non-blank lines for an opt-out directive. Walk past
    // declaration boilerplate (`const X = {`, type annotations) so the
    // directive can sit on the doc-comment line above the declaration.
    let optedOut = false;
    let lookback = i - 1;
    let nonBlankSeen = 0;
    while (lookback >= 0 && nonBlankSeen < 6) {
      const lb = lines[lookback].trim();
      if (lb === '') {
        lookback--;
        continue;
      }
      nonBlankSeen++;
      if (/verdict-priority-ok\b/.test(lb)) {
        optedOut = true;
        break;
      }
      lookback--;
    }
    if (optedOut) {
      // Skip past the entire run of priority assignments.
      let j = i + 1;
      while (j < lines.length) {
        const trimmed = lines[j].trim();
        if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('*')) {
          j++;
          continue;
        }
        if (!matchPriorityAssignment(lines[j])) break;
        j++;
      }
      i = j > i ? j : i + 1;
      continue;
    }
    const assignments: Array<{ name: VerdictName; value: number }> = [first];
    const startLine = i;
    let j = i + 1;
    while (j < lines.length) {
      const trimmed = lines[j].trim();
      if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('*')) {
        j++;
        continue;
      }
      const next = matchPriorityAssignment(lines[j]);
      if (!next) break;
      assignments.push(next);
      j++;
    }
    const distinctNames = new Set(assignments.map((a) => a.name));
    const distinctValues = new Set(assignments.map((a) => a.value));
    // A priority map needs 3+ distinct verdict keys AND 2+ distinct values
    // (counters with all-zero values don't trigger).
    if (distinctNames.size >= 3 && distinctValues.size >= 2) {
      violations.push({
        file: relPath,
        startLine: startLine + 1,
        matchedAssignments: assignments,
        preview: lines.slice(startLine, j).join('\n'),
      });
    }
    i = j > i ? j : i + 1;
  }

  return violations;
}

export function runCheck(): { passed: boolean; errors: number; violations: Violation[] } {
  const c = getColors();
  console.log(
    `${c.blue}Checking for ad-hoc verdict priority maps (QUA-429)...${c.reset}\n`,
  );

  const allFiles: string[] = [];
  for (const dir of SCAN_DIRS) {
    allFiles.push(...collectTsFiles(join(PROJECT_ROOT, dir)));
  }

  const allViolations: Violation[] = [];
  for (const file of allFiles) {
    allViolations.push(...checkFile(file));
  }

  if (allViolations.length === 0) {
    console.log(
      `${c.green}No ad-hoc verdict priority maps found (${allFiles.length} files checked)${c.reset}`,
    );
  } else {
    console.log(
      `${c.red}Found ${allViolations.length} ad-hoc verdict priority map(s):${c.reset}\n`,
    );
    for (const v of allViolations) {
      console.log(`  ${c.red}${v.file}:${v.startLine}${c.reset}`);
      console.log(
        `    ${c.dim}assignments: ${v.matchedAssignments
          .map((a) => `${a.name}=${a.value}`)
          .join(', ')}${c.reset}`,
      );
      const previewLines = v.preview.split('\n').slice(0, 8);
      for (const l of previewLines) {
        console.log(`    ${c.dim}${l}${c.reset}`);
      }
      console.log(
        `    ${c.dim}Fix: import SOURCE_CHECK_VERDICT_PRIORITY from @/components/shared/verdict-styles${c.reset}\n`,
      );
    }
  }

  return {
    passed: allViolations.length === 0,
    errors: allViolations.length,
    violations: allViolations,
  };
}

if (process.argv[1]?.includes('validate-verdict-priority')) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
