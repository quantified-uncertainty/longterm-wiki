#!/usr/bin/env node

/**
 * Sourcing lint guard — ratchet validator that prevents new `source-check`
 * references from accumulating while the system is renamed to `sourcing`.
 *
 * The rename is multi-phase (QUA-102, QUA-105..QUA-109) and will take weeks.
 * Until it lands, ~1000 existing references remain in the code. This guard
 * records a baseline count per category and fails if the total count
 * increases beyond the baseline. Refactors that redistribute references
 * within the existing implementation are allowed as long as the overall
 * count doesn't grow.
 *
 * Categories tracked:
 *   - hyphenated  — literal `source-check` anywhere in scanned files
 *   - camelCase   — `sourceCheck` identifier-style
 *   - PascalCase  — `SourceCheck` type/class-style
 *   - route       — `/api/source-check` URL path
 *
 * Scope: crux/, apps/web/src/, apps/wiki-server/src/
 * Extensions: .ts, .tsx, .mts, .mjs
 * Excluded: node_modules, __tests__/, *.test.ts, the validator itself,
 *           the baseline file, and validate-source-check-* (existing data-quality
 *           validators that legitimately name the old pattern).
 *
 * Usage:
 *   npx tsx crux/validate/validate-sourcing-lint-guard.ts            # check
 *   npx tsx crux/validate/validate-sourcing-lint-guard.ts --update   # rewrite baseline
 */

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';

const BASELINE_PATH = join(PROJECT_ROOT, 'crux/validate/.sourcing-baseline.json');

const SCAN_DIRS = [
  'crux',
  'apps/web/src',
  'apps/wiki-server/src',
];

const SCAN_EXTS = ['.ts', '.tsx', '.mts', '.mjs'];

/**
 * File names / substrings to skip entirely. These are either the validator
 * itself (which must literally contain the banned patterns to check for
 * them) or existing unrelated validators that legitimately reference the
 * old name in their own domain.
 */
const SKIP_FILENAMES = [
  'validate-sourcing-lint-guard.ts',
  'validate-sourcing-lint-guard.test.ts',
  'validate-source-check-names.ts',
  'validate-source-check-coverage.ts',
  'validate-source-check-coverage.test.ts',
];

/**
 * Directory names to skip during traversal.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '__tests__',
  '.next',
  'dist',
  'build',
  '.turbo',
]);

interface Counts {
  hyphenated: number;
  camelCase: number;
  PascalCase: number;
  route: number;
  total: number;
}

interface Baseline extends Counts {
  /** Timestamp of last baseline update, for audit */
  updatedAt: string;
  /** Notes on why the baseline is what it is */
  notes: string;
}

const ZERO_COUNTS: Counts = {
  hyphenated: 0,
  camelCase: 0,
  PascalCase: 0,
  route: 0,
  total: 0,
};

/** Patterns scanned, in order of specificity so route matches are subtracted from hyphenated. */
const ROUTE_RE = /\/api\/source-check/g;
const HYPHEN_RE = /source-check/g;
const CAMEL_RE = /\bsourceCheck[A-Z_0-9]/g;
const PASCAL_RE = /\bSourceCheck[A-Z_a-z0-9]/g;

export function countInText(text: string): Counts {
  const routeMatches = text.match(ROUTE_RE)?.length ?? 0;
  const hyphenAll = text.match(HYPHEN_RE)?.length ?? 0;
  // Route matches are a strict subset of hyphenated matches (`/api/source-check`
  // contains `source-check`). Subtract to avoid double counting.
  const hyphenated = Math.max(0, hyphenAll - routeMatches);
  const camelCase = text.match(CAMEL_RE)?.length ?? 0;
  const PascalCase = text.match(PASCAL_RE)?.length ?? 0;
  const total = hyphenated + routeMatches + camelCase + PascalCase;
  return { hyphenated, camelCase, PascalCase, route: routeMatches, total };
}

function addCounts(a: Counts, b: Counts): Counts {
  return {
    hyphenated: a.hyphenated + b.hyphenated,
    camelCase: a.camelCase + b.camelCase,
    PascalCase: a.PascalCase + b.PascalCase,
    route: a.route + b.route,
    total: a.total + b.total,
  };
}

function shouldSkipFile(filename: string): boolean {
  if (SKIP_FILENAMES.includes(filename)) return true;
  if (filename.endsWith('.test.ts')) return true;
  if (filename.endsWith('.test.tsx')) return true;
  return false;
}

function collectFiles(dir: string): string[] {
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
        if (SKIP_DIRS.has(entry)) continue;
        walk(fullPath);
        continue;
      }
      if (shouldSkipFile(entry)) continue;
      if (!SCAN_EXTS.some((ext) => entry.endsWith(ext))) continue;
      results.push(fullPath);
    }
  }
  walk(dir);
  return results;
}

export function scanCodebase(): { counts: Counts; filesScanned: number } {
  let totals = { ...ZERO_COUNTS };
  let filesScanned = 0;
  for (const dir of SCAN_DIRS) {
    const absDir = join(PROJECT_ROOT, dir);
    if (!existsSync(absDir)) continue;
    const files = collectFiles(absDir);
    for (const file of files) {
      filesScanned++;
      const text = readFileSync(file, 'utf-8');
      totals = addCounts(totals, countInText(text));
    }
  }
  return { counts: totals, filesScanned };
}

function loadBaseline(): Baseline | null {
  if (!existsSync(BASELINE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as Baseline;
  } catch {
    return null;
  }
}

function writeBaseline(counts: Counts, notes: string): void {
  const baseline: Baseline = {
    ...counts,
    updatedAt: new Date().toISOString(),
    notes,
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n', 'utf-8');
}

interface CheckResult {
  passed: boolean;
  current: Counts;
  baseline: Counts | null;
  filesScanned: number;
  message: string;
}

export function runCheck(): CheckResult {
  const { counts, filesScanned } = scanCodebase();
  const baseline = loadBaseline();

  if (!baseline) {
    return {
      passed: false,
      current: counts,
      baseline: null,
      filesScanned,
      message:
        'No baseline found. Run `npx tsx crux/validate/validate-sourcing-lint-guard.ts --update` ' +
        'to create it, then commit crux/validate/.sourcing-baseline.json.',
    };
  }

  const categories: (keyof Counts)[] = [
    'hyphenated',
    'camelCase',
    'PascalCase',
    'route',
    'total',
  ];
  const regressions: string[] = [];
  for (const cat of categories) {
    if (counts[cat] > baseline[cat]) {
      regressions.push(
        `  ${cat}: ${baseline[cat]} → ${counts[cat]} (+${counts[cat] - baseline[cat]})`,
      );
    }
  }

  if (regressions.length > 0) {
    const message =
      'New source-check references detected beyond baseline:\n' +
      regressions.join('\n') +
      '\n\nThe sourcing rename (QUA-102, QUA-105..QUA-109) is in progress. ' +
      'New code should use "sourcing" terminology, not "source-check".\n' +
      'If this change is a legitimate refactor of existing source-check code ' +
      'and the overall count should stay flat or fall, check whether the code ' +
      'being edited already contains these patterns (the ratchet compares ' +
      'total counts, not per-file counts).';
    return { passed: false, current: counts, baseline, filesScanned, message };
  }

  const drops: string[] = [];
  for (const cat of categories) {
    if (counts[cat] < baseline[cat]) {
      drops.push(`  ${cat}: ${baseline[cat]} → ${counts[cat]} (-${baseline[cat] - counts[cat]})`);
    }
  }

  if (drops.length > 0) {
    return {
      passed: true,
      current: counts,
      baseline,
      filesScanned,
      message:
        `Sourcing references reduced — consider lowering the baseline:\n` +
        drops.join('\n') +
        `\n\nRun \`npx tsx crux/validate/validate-sourcing-lint-guard.ts --update\` ` +
        `and commit .sourcing-baseline.json.`,
    };
  }

  return {
    passed: true,
    current: counts,
    baseline,
    filesScanned,
    message: `At baseline (${counts.total} references across ${filesScanned} files)`,
  };
}

function main(): void {
  const c = getColors();
  const args = process.argv.slice(2);
  const updateMode = args.includes('--update') || args.includes('--update-baseline');

  if (updateMode) {
    const { counts, filesScanned } = scanCodebase();
    const notes =
      'Ratchet baseline for source-check → sourcing rename. ' +
      'Only lower this value; never raise without justification. ' +
      'Tracked under QUA-103 (lint guard), QUA-102 (rename umbrella).';
    writeBaseline(counts, notes);
    console.log(`${c.green}Baseline updated.${c.reset}`);
    console.log(`  Files scanned: ${filesScanned}`);
    console.log(`  Total: ${counts.total}`);
    console.log(`    hyphenated: ${counts.hyphenated}`);
    console.log(`    camelCase: ${counts.camelCase}`);
    console.log(`    PascalCase: ${counts.PascalCase}`);
    console.log(`    route: ${counts.route}`);
    console.log(`\n  Wrote: ${relative(PROJECT_ROOT, BASELINE_PATH)}`);
    return;
  }

  console.log(`${c.blue}Checking sourcing lint guard...${c.reset}`);
  const result = runCheck();

  if (!result.passed) {
    console.log(`${c.red}${result.message}${c.reset}`);
    console.log(`\n  Current: ${result.current.total} total`);
    if (result.baseline) {
      console.log(`  Baseline: ${result.baseline.total} total`);
    }
    process.exit(1);
  }

  console.log(`${c.green}${result.message}${c.reset}`);
  if (result.baseline && result.current.total === result.baseline.total) {
    console.log(`  ${c.dim}${result.filesScanned} files scanned${c.reset}`);
  }
}

if (process.argv[1]?.includes('validate-sourcing-lint-guard')) {
  main();
}
