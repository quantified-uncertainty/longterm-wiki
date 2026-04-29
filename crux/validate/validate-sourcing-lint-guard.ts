#!/usr/bin/env node

/**
 * Sourcing lint guard — ratchet validator that prevents new `source-check`
 * references from accumulating while the system is renamed to `sourcing`.
 *
 * The rename is multi-phase (QUA-102, QUA-105..QUA-109, QUA-237) and will take weeks.
 * This guard records a baseline count per category and fails if the total
 * count of legacy `source-check` references increases beyond the baseline.
 * Refactors that redistribute references within the existing implementation
 * are allowed as long as the overall count doesn't grow.
 *
 * Categories tracked:
 *   - hyphenated  — literal `source-check` anywhere in scanned files
 *   - camelCase   — `sourceCheck` identifier-style
 *   - PascalCase  — `SourceCheck` type/class-style
 *   - route       — `/api/source-checks` URL path
 *
 * Scope: crux/, apps/web/src/, apps/wiki-server/src/
 * Extensions: .ts, .tsx, .mts, .mjs
 * Excluded: node_modules, __tests__/, *.test.ts, the validator itself,
 *           the baseline file, and validate-sourcing-* (existing data-quality
 *           validators that legitimately name the old pattern).
 *
 * Usage:
 *   npx tsx crux/validate/validate-sourcing-lint-guard.ts            # check
 *   npx tsx crux/validate/validate-sourcing-lint-guard.ts --update   # rewrite baseline
 */

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
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
  'validate-sourcing-names.ts',
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

/**
 * Patterns scanned — these detect LEGACY "source-check" terminology.
 * Route matches are a strict subset of hyphenated matches
 * and are subtracted in `countInText`.
 *
 * The camelCase and PascalCase patterns match either bare identifiers
 * (`sourceCheck`, `SourceCheck`) or extended forms (`sourceCheckClient`,
 * `SourceCheckResult`) — anything that starts with the legacy prefix
 * at a word boundary and continues to a word boundary.
 */
const ROUTE_RE = /\/api\/source-checks/g;
const HYPHEN_RE = /source-check/g;
const CAMEL_RE = /\bsourceCheck[A-Za-z0-9_]*\b/g;
const PASCAL_RE = /\bSourceCheck[A-Za-z0-9_]*\b/g;

export function countInText(text: string): Counts {
  const routeMatches = text.match(ROUTE_RE)?.length ?? 0;
  const hyphenAll = text.match(HYPHEN_RE)?.length ?? 0;
  // Route matches are a strict subset of hyphenated matches (`/api/source-checks`
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

  // The ratchet compares total counts only — refactors that redistribute
  // references across categories (e.g., renaming a route to a non-route
  // hyphenated form) are allowed as long as the overall total doesn't rise.
  const perCategoryDeltas: string[] = [];
  const bucketCategories: (keyof Counts)[] = [
    'hyphenated',
    'camelCase',
    'PascalCase',
    'route',
  ];
  for (const cat of bucketCategories) {
    const delta = counts[cat] - baseline[cat];
    if (delta !== 0) {
      const sign = delta > 0 ? '+' : '';
      perCategoryDeltas.push(
        `  ${cat}: ${baseline[cat]} → ${counts[cat]} (${sign}${delta})`,
      );
    }
  }

  if (counts.total > baseline.total) {
    const message =
      `Total legacy-term count rose from ${baseline.total} to ${counts.total} ` +
      `(+${counts.total - baseline.total}):\n` +
      perCategoryDeltas.join('\n') +
      '\n\nThe source-check → sourcing rename (QUA-102, QUA-237) is in progress. ' +
      'New code should use "sourcing" terminology, not "source-check". Refactors ' +
      'that redistribute existing references across categories are allowed as ' +
      'long as the total stays flat or falls — only the total is enforced.';
    return { passed: false, current: counts, baseline, filesScanned, message };
  }

  if (counts.total < baseline.total) {
    return {
      passed: true,
      current: counts,
      baseline,
      filesScanned,
      message:
        `Total dropped from ${baseline.total} to ${counts.total} ` +
        `(-${baseline.total - counts.total}) — consider lowering the baseline:\n` +
        perCategoryDeltas.join('\n') +
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
      'FROZEN per QUA-296. The 5 non-route references (hyphenated + camelCase) ' +
      'are structural: they bind to DB columns source_check_evidence and ' +
      'source_check_verdicts via Drizzle. Driving total below 5 requires ' +
      'renaming those tables (rejected as high-risk for cosmetic gain — see ' +
      'QUA-296). Route references will drop to 0 once QUA-301 client migration ' +
      'completes. Until then, do not lower the total without first reading ' +
      'QUA-296. Tracked under QUA-103 (lint guard), QUA-102 (rename umbrella), ' +
      'QUA-296 (freeze decision).';
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
    // On non-main branches, the ratchet is advisory — PRs that add
    // sourcing features naturally increase the count temporarily.
    // The ratchet enforces on main merges. See QUA-238.
    const branch = process.env.GITHUB_HEAD_REF
      || process.env.GITHUB_REF
      || execSync('git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown').toString().trim();
    const isMain = branch === 'main' || branch === 'refs/heads/main';

    if (!isMain) {
      console.log(`${c.yellow}${result.message} (advisory on branch "${branch}")${c.reset}`);
      console.log(`  ${c.dim}Ratchet only blocks on main. See QUA-238.${c.reset}`);
      // Exit 0 so the gate check doesn't block PR pushes
    } else {
      console.log(`${c.red}${result.message}${c.reset}`);
      console.log(`\n  Current: ${result.current.total} total`);
      if (result.baseline) {
        console.log(`  Baseline: ${result.baseline.total} total`);
      }
      process.exit(1);
    }
  }

  console.log(`${c.green}${result.message}${c.reset}`);
  if (result.baseline && result.current.total === result.baseline.total) {
    console.log(`  ${c.dim}${result.filesScanned} files scanned${c.reset}`);
  }
}

if (process.argv[1]?.includes('validate-sourcing-lint-guard')) {
  main();
}
