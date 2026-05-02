#!/usr/bin/env node

/**
 * QUA-1006: Standardize cell formatting across directory tables.
 *
 * Flags ad-hoc `.toLocaleString(...)`, `.toLocaleDateString(...)`, and
 * `Intl.NumberFormat` calls in directory table components — anything under
 * `apps/web/src/app/<directory>/*-table.tsx` (and the same suffix in nested
 * dirs). Internal admin tables under `apps/web/src/app/internal/` are not
 * in scope for this validator (they may have specialized formatting needs);
 * the rule is enforced for user-facing directory tables only.
 *
 * The replacement is to import from `@/lib/format-compact` (formatCompactCurrency,
 * formatCompactNumber, formatCount) or `@/lib/format` (formatDateDeterministic).
 *
 * Allow markers (place on the same line or the line above):
 *   `// table-formatting-ok: <reason>` — explicit opt-out for cases where the
 *   shared helpers don't fit (e.g. specialized rounding for context windows).
 *
 * Usage: npx tsx crux/validate/validate-table-formatting.ts
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';

const SCAN_ROOT = 'apps/web/src/app';

/** Banned patterns and the suggested replacement helper. */
const BANNED_PATTERNS: { pattern: RegExp; suggest: string; label: string }[] = [
  {
    pattern: /\.toLocaleString\s*\(/,
    suggest: 'formatCount / formatCompactNumber from @/lib/format-compact',
    label: '.toLocaleString',
  },
  {
    pattern: /\.toLocaleDateString\s*\(/,
    suggest: 'formatDateDeterministic from @/lib/format',
    label: '.toLocaleDateString',
  },
  {
    pattern: /\bIntl\.NumberFormat\b/,
    suggest: 'formatCompactCurrency / formatCompactNumber from @/lib/format-compact',
    label: 'Intl.NumberFormat',
  },
  {
    pattern: /\bIntl\.DateTimeFormat\b/,
    suggest: 'formatDateDeterministic from @/lib/format',
    label: 'Intl.DateTimeFormat',
  },
];

export const ALLOW_MARKER = 'table-formatting-ok';

export interface BannedHit {
  label: string;
  suggest: string;
}

interface Violation {
  file: string;
  line: number;
  text: string;
  label: string;
  suggest: string;
}

/**
 * Pure helper: returns null if `line` is clean, or `{label, suggest}` for the
 * first banned pattern it matches. Honors the same-line and previous-line
 * `// table-formatting-ok` marker, plus comment-line skips. Exposed for unit
 * tests so the matching logic can be exercised without filesystem setup.
 */
export function lineHasBannedFormatter(
  line: string,
  prevLine: string = '',
): BannedHit | null {
  if (isCommentLine(line)) return null;
  if (line.includes(ALLOW_MARKER)) return null;
  if (isCommentLine(prevLine) && prevLine.includes(ALLOW_MARKER)) return null;
  for (const { pattern, suggest, label } of BANNED_PATTERNS) {
    if (pattern.test(line)) return { label, suggest };
  }
  return null;
}

/** Recursively collect *-table.tsx files under apps/web/src/app, excluding internal/. */
function collectTableFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(current: string, isUnderInternal: boolean): void {
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
        if (entry === 'node_modules' || entry === '__tests__') continue;
        const nextInternal = isUnderInternal || entry === 'internal';
        walk(fullPath, nextInternal);
      } else if (
        !isUnderInternal &&
        (entry.endsWith('-table.tsx') || entry.endsWith('Table.tsx'))
      ) {
        results.push(fullPath);
      }
    }
  }

  walk(dir, false);
  return results;
}

function isCommentLine(s: string): boolean {
  const t = s.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function checkFile(filePath: string): Violation[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const violations: Violation[] = [];
  const relPath = relative(PROJECT_ROOT, filePath);

  for (let i = 0; i < lines.length; i++) {
    const hit = lineHasBannedFormatter(lines[i], i > 0 ? lines[i - 1] : '');
    if (hit) {
      violations.push({
        file: relPath,
        line: i + 1,
        text: lines[i].trim(),
        label: hit.label,
        suggest: hit.suggest,
      });
    }
  }

  return violations;
}

export function runCheck(): { passed: boolean; errors: number; violations: Violation[] } {
  const c = getColors();
  console.log(`${c.blue}Checking directory table formatting (QUA-1006)...${c.reset}\n`);

  const absDir = join(PROJECT_ROOT, SCAN_ROOT);
  const files = collectTableFiles(absDir);

  if (files.length === 0) {
    console.log(`${c.dim}No directory table files found${c.reset}`);
    return { passed: true, errors: 0, violations: [] };
  }

  const allViolations: Violation[] = [];
  for (const file of files) {
    allViolations.push(...checkFile(file));
  }

  if (allViolations.length === 0) {
    console.log(
      `${c.green}No ad-hoc formatters in directory tables (${files.length} files checked)${c.reset}`,
    );
  } else {
    console.log(
      `${c.red}Found ${allViolations.length} ad-hoc formatter call(s) in directory tables:${c.reset}\n`,
    );
    for (const v of allViolations) {
      console.log(`  ${c.red}${v.file}:${v.line}${c.reset}  [${v.label}]`);
      console.log(`    ${c.dim}${v.text}${c.reset}`);
      console.log(`    ${c.dim}Fix: use ${v.suggest}${c.reset}`);
      console.log(
        `    ${c.dim}Or add a // ${ALLOW_MARKER}: <reason> marker on the same line or line above${c.reset}\n`,
      );
    }
  }

  return {
    passed: allViolations.length === 0,
    errors: allViolations.length,
    violations: allViolations,
  };
}

if (process.argv[1]?.includes('validate-table-formatting')) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
