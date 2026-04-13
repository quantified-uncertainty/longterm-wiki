/**
 * Validator: GitHub check conclusion enum exhaustiveness.
 *
 * Background: QUA-339 PR #4245 shipped two sibling checks that each parsed
 * the `conclusion` field from `gh pr list` / `gh run list` output. The first
 * used `/fail|cancel|error/i` (missed `timed_out` and `action_required`), the
 * second used `/failure|cancelled|timed_out/` (still missed `action_required`
 * and `startup_failure`). Both reported failing CI runs as "no failing
 * checks" because the regex didn't cover the full GitHub enum.
 *
 * GitHub's check-runs API lists the canonical failure conclusions as:
 *   failure | cancelled | timed_out | action_required | startup_failure
 * Plus non-failures: success | neutral | skipped | stale
 *
 * This validator scans every `.ts` / `.mjs` file under `crux/` (and
 * `apps/` where relevant) for regex literals whose source mentions any
 * conclusion keyword, and flags those that are missing one or more of the
 * required failing variants. False positives are suppressible with a
 * `// conclusion-enum-ok: <reason>` comment on the same or previous line.
 *
 * Exit code:
 *   0 — no violations
 *   1 — one or more regexes are missing required conclusion variants
 *
 * Run standalone: npx tsx crux/validate/validate-github-conclusion-enum.ts
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';

/** The canonical set of conclusions GitHub treats as failures. */
const FAILING_CONCLUSIONS = [
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'startup_failure',
] as const;

/** Tokens that imply the regex is scoped to check-conclusion parsing. */
const CONCLUSION_KEYWORDS = /conclusion|statusCheck|check[_\s]?run|ci[_\s]?run/i;

/**
 * Tokens that imply the regex is trying to match FAILING conclusions.
 * Includes truncated forms (`fail`, `cancel`) because the pass-1 QUA-339
 * bug literally used those — that's the whole point of the check.
 *
 * Does NOT include success-flavored tokens (`success`, `neutral`, `skipped`,
 * `stale`) — a regex matching those is probably the inverse check and
 * shouldn't be forced to include failing names.
 */
const FAILING_FLAVORED_TOKEN_RE =
  /(failure|fail|cancelled|cancel|error|timed_out|timeout|action_required|startup_failure)/i;

/** The suppression marker, e.g. `// conclusion-enum-ok: see QUA-xxx` */
const SUPPRESSION_RE = /\/\/\s*conclusion-enum-ok\b/;

interface Violation {
  file: string;
  line: number;
  regexSource: string;
  missing: string[];
}

interface ScanOptions {
  rootDirs: string[];
}

function collectFiles(root: string): string[] {
  const out: string[] = [];
  function walk(d: string) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === '__tests__') continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|mjs)$/.test(entry.name)) continue;
      if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts')) continue;
      // Skip this validator itself so its literal FAILING_CONCLUSIONS list
      // isn't flagged as "incomplete regex".
      if (full.includes('validate-github-conclusion-enum.ts')) continue;
      out.push(full);
    }
  }
  try {
    if (statSync(root).isDirectory()) walk(root);
  } catch {
    // missing dir — skip silently
  }
  return out;
}

/**
 * Scan a single file for regex literals whose source mentions conclusion
 * tokens, and return any that don't cover the full FAILING_CONCLUSIONS set.
 */
export function scanFileContent(filePath: string, content: string): Violation[] {
  const lines = content.split('\n');
  const violations: Violation[] = [];
  const rel = relative(PROJECT_ROOT, filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Cheap prefilter: skip lines that don't even mention conclusion-ish context.
    if (!CONCLUSION_KEYWORDS.test(line)) continue;
    // Suppression check on this line OR the line above.
    if (SUPPRESSION_RE.test(line)) continue;
    if (i > 0 && SUPPRESSION_RE.test(lines[i - 1])) continue;

    // Find every regex literal on this line.
    // Simple extractor: match `/` ... unescaped `/` on one line.
    // Good enough — the /failure|timed_out/-shaped literals the bug
    // class produces all fit on one line.
    const literals = extractRegexLiterals(line);
    for (const lit of literals) {
      // Only inspect regexes that LOOK like they're trying to match
      // failing conclusions (includes truncated forms like `fail` /
      // `cancel` — pass-1 of the QUA-339 bug used exactly those).
      if (!FAILING_FLAVORED_TOKEN_RE.test(lit)) continue;
      // Canonical check: does this literal cover every failing full name?
      const missing = FAILING_CONCLUSIONS.filter((v) => !lit.includes(v));
      if (missing.length === 0) continue;
      violations.push({
        file: rel,
        line: i + 1,
        regexSource: lit,
        missing,
      });
    }
  }
  return violations;
}

/**
 * Extract regex literals from a single line of JS/TS. Handles the common
 * cases: `/foo/`, `/foo/flags`, `foo.replace(/bar/g, ...)`. Does NOT try
 * to be a full JS lexer — the bug class we care about always has a
 * simple single-line regex.
 */
function extractRegexLiterals(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch !== '/') {
      i++;
      continue;
    }
    // Heuristic: is this a division or a regex literal?
    // Treat as a regex if the previous non-space char is one of
    // `=(,!&|?:{};[` or the `>` from an arrow function `=>`, or
    // start-of-line. This mirrors how JS parsers disambiguate regex
    // vs division without a full state machine.
    const prev = previousNonSpace(line, i);
    const prevTwo = previousNonSpaceTwo(line, i);
    const startsRegex =
      prev == null ||
      /[=(,!&|?:{};[]/.test(prev) ||
      prevTwo === '=>' ||
      prev === 'n' && /\breturn$/.test(line.slice(0, i).trimEnd()); // `return /foo/`
    if (!startsRegex) { i++; continue; }
    // Scan until unescaped `/`
    let j = i + 1;
    let escaped = false;
    let inClass = false;
    for (; j < line.length; j++) {
      const c = line[j];
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '[') { inClass = true; continue; }
      if (c === ']') { inClass = false; continue; }
      if (c === '/' && !inClass) break;
    }
    if (j >= line.length) { i++; continue; }
    // Consume trailing flags
    let k = j + 1;
    while (k < line.length && /[gimsuy]/.test(line[k])) k++;
    out.push(line.slice(i, k));
    i = k;
  }
  return out;
}

function previousNonSpace(line: string, pos: number): string | null {
  for (let i = pos - 1; i >= 0; i--) {
    if (line[i] !== ' ' && line[i] !== '\t') return line[i];
  }
  return null;
}

/** Return the two non-space chars immediately before `pos`, joined. */
function previousNonSpaceTwo(line: string, pos: number): string | null {
  let found = '';
  for (let i = pos - 1; i >= 0 && found.length < 2; i--) {
    if (line[i] !== ' ' && line[i] !== '\t') found = line[i] + found;
  }
  return found.length === 2 ? found : null;
}

function scanAll(options: ScanOptions): Violation[] {
  const out: Violation[] = [];
  for (const root of options.rootDirs) {
    for (const file of collectFiles(root)) {
      const content = readFileSync(file, 'utf-8');
      out.push(...scanFileContent(file, content));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

// Only run the CLI entrypoint when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = scanAll({
    rootDirs: [
      join(PROJECT_ROOT, 'crux'),
      join(PROJECT_ROOT, 'apps/web/src'),
      join(PROJECT_ROOT, 'apps/wiki-server/src'),
    ],
  });

  if (violations.length === 0) {
    console.log('✓ GitHub conclusion enum exhaustiveness: no violations');
    process.exit(0);
  }

  console.error(`✗ ${violations.length} GitHub conclusion regex(es) missing failing variants:\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    regex:   ${v.regexSource}`);
    console.error(`    missing: ${v.missing.join(', ')}`);
    console.error('');
  }
  console.error('Fix options:');
  console.error('  1. Extend the regex to cover all FAILING_CONCLUSIONS:');
  console.error('     /failure|cancelled|timed_out|action_required|startup_failure/');
  console.error('  2. Better: switch to an allowlist helper');
  console.error('     e.g. import { isFailingConclusion } from "./github-conclusions.ts"');
  console.error('  3. If intentional (e.g. the regex is scoped to a narrower state),');
  console.error('     suppress with `// conclusion-enum-ok: <reason>` on the same or');
  console.error('     previous line.');
  process.exit(1);
}
