#!/usr/bin/env node

/**
 * Validate that the codebase doesn't introduce data-integrity anti-patterns.
 *
 * Part of epic #4017 ("Data integrity: systemic gaps across schema, validation,
 * write paths"). Phase A — stop the bleeding by catching new instances of the
 * patterns that cause the issues fixed in PR #4020 (Tier 0).
 *
 * Patterns flagged:
 *
 *   1. Silent .catch() — `.catch(() => {})` swallows errors with no diagnostic.
 *      Banned per `.claude/rules/error-handling.md`.
 *      Suppression: `// catch-ok: <reason>`
 *
 *   2. Warn-only .catch() — `.catch((e) => console.warn(...))` or
 *      `.catch((e) => logger.warn(...))` where the catch body contains ONLY a
 *      warn call. This pattern was the root cause of Fix 0.3 — primary-data
 *      writes silently dropped. Acceptable for telemetry/heartbeats with an
 *      explicit reason; everything else should propagate or use logger.error.
 *      Suppression: `// catch-ok: <reason>`
 *
 *   3. `as any` and `as unknown as` casts in wiki-server route files. Routes
 *      should use Zod validation or typed row interfaces, not unsafe casts.
 *      Suppression: `// as-any-ok: <reason>`
 *
 *   4. Hardcoded `?skipEntityValidation=true` in URL strings without a
 *      neighbouring `// skipEntityValidation-ok: <reason>` comment. Per
 *      epic #4017 Phase A, this bypass must be loud and justified.
 *      Suppression: `// skipEntityValidation-ok: <reason>`
 *
 * Excluded:
 *   - Test files (__tests__/, *.test.ts) — test fixtures legitimately need
 *     these patterns to exercise error paths
 *   - node_modules/
 *
 * Usage: npx tsx crux/validate/validate-dangerous-patterns.ts
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';

/** Directories to scan (relative to PROJECT_ROOT). */
const SCAN_DIRS = [
  'apps/wiki-server/src',
  'apps/groundskeeper/src',
  'crux',
];

/** Subset of SCAN_DIRS where `as any` is forbidden. Routes must use typed rows. */
const ROUTE_DIRS = ['apps/wiki-server/src/routes'];

interface Violation {
  file: string;
  line: number;
  text: string;
  pattern: PatternId;
}

type PatternId =
  | 'silent-catch'
  | 'warn-only-catch'
  | 'as-any-in-route'
  | 'skip-entity-validation';

interface PatternMeta {
  id: PatternId;
  description: string;
  fix: string;
  suppressionMarker: string;
}

const PATTERN_META: Record<PatternId, PatternMeta> = {
  'silent-catch': {
    id: 'silent-catch',
    description: 'Silent .catch(() => {}) swallows errors with no diagnostic', // catch-ok: literal pattern in description string (not actual code)
    fix: 'Log with logger.warn/error or re-throw. If genuinely best-effort, add `// catch-ok: <reason>` on the same line.',
    suppressionMarker: 'catch-ok',
  },
  'warn-only-catch': {
    id: 'warn-only-catch',
    description: 'Warn-only .catch() — primary-data writes must propagate failures, not log-and-resolve',
    fix: 'Re-throw the error or use logger.error + a tracking counter. If genuinely telemetry, add `// catch-ok: <reason>` on the same line.',
    suppressionMarker: 'catch-ok',
  },
  'as-any-in-route': {
    id: 'as-any-in-route',
    description: '`as any` / `as unknown as` cast in a wiki-server route — routes must use Zod or typed row interfaces',
    fix: 'Use a typed row interface or Zod schema. If a generic Drizzle table requires the cast, add `// as-any-ok: <reason>` on the same line.',
    suppressionMarker: 'as-any-ok',
  },
  'skip-entity-validation': {
    id: 'skip-entity-validation',
    description: 'skipEntityValidation=true used without a justification comment — entity validation bypass must be loud', // skipEntityValidation-ok: literal pattern in description (not actual code)
    fix: 'Add `// skipEntityValidation-ok: <reason>` on the same line explaining why FK validation is being bypassed.',
    suppressionMarker: 'skipEntityValidation-ok',
  },
};

// ---------------------------------------------------------------------------
// Pattern detection — pure functions (exported for unit tests)
// ---------------------------------------------------------------------------

/** `.catch(() => {})` or `.catch(() => {  })` — silent swallow. */
const SILENT_CATCH_PATTERN = /\.catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/;

/**
 * `.catch((e) => console.warn(...))` / `.catch((e) => logger.warn(...))`
 * Single-expression arrow body, no braces, no statements other than the warn call.
 *
 * We deliberately do NOT match brace bodies — those usually contain additional
 * logic (counter increments, re-throws, etc.) and the warn pattern is the
 * "fire and forget plus a log" anti-pattern from issue #4017.
 *
 * The `[^)]*` parameter list happily matches `(e)`, `(e: unknown)`, `e`, `()`, etc.
 *
 * Known limitation: only matches single-line arrow bodies. A `.catch((e) =>\n  warn(...))`
 * split across lines is NOT detected. This is documented as out-of-scope for the
 * regex-based detector; the gate is a deterrent, not a proof. A reviewer should
 * still flag obvious bypasses regardless of formatting.
 */
const WARN_ONLY_CATCH_PATTERN =
  /\.catch\s*\(\s*(?:\(\s*[^)]*\)|\w*)\s*=>\s*(?:console\.warn|logger\.warn)\s*\(/;

/** `as any` and `as unknown as` casts. */
const AS_ANY_PATTERN = /\bas\s+(?:unknown\s+as\s+)?any\b/;

/**
 * Hardcoded `?skipEntityValidation=true` in URL string literals (single, double,
 * or backtick), or as a `?...&skipEntityValidation=true` query param.
 *
 * Narrowed in PR review to URL-string-literal context only — the previous
 * `skipEntityValidation: true` form was matching legitimate option-passing
 * code (default params, destructured options) without justification.
 *
 * The wrapper functions in `personnel.ts` and `tablebase.ts` now enforce the
 * reason at runtime, so option-passing code is already covered defensively;
 * the gate check focuses on raw URL bypasses that don't go through the wrapper.
 */
// skipEntityValidation-ok: regex pattern references the bypass keyword by design
const SKIP_ENTITY_VALIDATION_PATTERN = /["'`][^"'`]*[?&]skipEntityValidation=true/;

/**
 * Build a strict suppression-marker regex. The marker MUST appear in the form
 * `<marker>: <reason>` (with a non-empty reason after the colon). The caller
 * passes only the comment portion of a line, so this regex never sees code
 * outside of comments.
 *
 * Reviewed from the diff subagent finding HIGH#1 — `String.includes()` was
 * too permissive.
 */
function buildSuppressionRegex(marker: string): RegExp {
  const escaped = marker.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\s*:\\s*\\S`);
}

const SUPPRESSION_REGEXES: Record<PatternId, RegExp> = Object.fromEntries(
  Object.entries(PATTERN_META).map(([id, meta]) => [
    id,
    buildSuppressionRegex(meta.suppressionMarker),
  ]),
) as Record<PatternId, RegExp>;

/**
 * Extract the inline comment portion of a line, ignoring `//` sequences that
 * appear inside string or template literals. Returns the comment text (the
 * substring after the `//`) or `null` if there is no real inline comment.
 *
 * Implementation: walk the line character-by-character tracking string state.
 * Handles single quotes, double quotes, backticks, and escape sequences.
 *
 * This protects suppression detection from false positives where a marker
 * keyword appears inside a string literal (PR review HIGH#1 follow-up).
 *
 * Exported for unit tests.
 */
export function extractInlineComment(line: string): string | null {
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  while (i < line.length) {
    const ch = line[i];
    const next = line[i + 1];
    if (inSingle) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === "'") inSingle = false;
    } else if (inDouble) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') inDouble = false;
    } else if (inBacktick) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') inBacktick = false;
    } else {
      if (ch === "'") inSingle = true;
      else if (ch === '"') inDouble = true;
      else if (ch === '`') inBacktick = true;
      else if (ch === '/' && next === '/') {
        return line.slice(i + 2);
      }
      else if (ch === '/' && next === '*') {
        // Block comment — return everything after `/*`. The regex tolerates
        // trailing `*/` because the marker form is `<marker>: <reason>` and
        // a trailing `*/` doesn't match `\b<marker>`.
        return line.slice(i + 2);
      }
    }
    i++;
  }
  return null;
}

/**
 * Check a single line for all enabled patterns. Returns the patterns matched,
 * minus any whose suppression marker appears in a comment on the same line OR
 * a comment-only line immediately above.
 *
 * Suppression markers must be in the form `// <marker>: <reason>` — a stricter
 * form than substring inclusion to prevent accidental over-suppression
 * (PR review HIGH#1).
 *
 * Exported for unit tests.
 */
export function checkLine(
  line: string,
  options: { isRouteFile: boolean; previousLine?: string }
): PatternId[] {
  const trimmed = line.trimStart();

  // Skip commented-out lines (but not lines that have inline comments)
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
    return [];
  }

  const matched: PatternId[] = [];

  if (SILENT_CATCH_PATTERN.test(line)) {
    matched.push('silent-catch');
  }

  if (WARN_ONLY_CATCH_PATTERN.test(line)) {
    // Don't double-count: a silent catch isn't also a warn-only catch.
    if (!matched.includes('silent-catch')) {
      matched.push('warn-only-catch');
    }
  }

  if (options.isRouteFile && AS_ANY_PATTERN.test(line)) {
    matched.push('as-any-in-route');
  }

  if (SKIP_ENTITY_VALIDATION_PATTERN.test(line)) {
    matched.push('skip-entity-validation');
  }

  // Filter out anything suppressed by a marker in a real comment — either
  // inline on the same line, or on a comment-only line immediately above.
  // The marker is searched in COMMENT TEXT only, not the full line, so a
  // marker substring inside a string literal does not accidentally suppress.
  const inlineComment = extractInlineComment(line);
  const prev = options.previousLine?.trimStart() ?? '';
  const prevIsCommentOnly =
    prev.startsWith('//') || prev.startsWith('/*') || prev.startsWith('*');
  // Strip the comment opener so the marker regex sees just the comment text.
  const prevComment = prevIsCommentOnly
    ? prev.replace(/^\/\/\s*|^\/\*\s*|^\*\s*/, '')
    : null;

  return matched.filter((id) => {
    const re = SUPPRESSION_REGEXES[id];
    if (inlineComment !== null && re.test(inlineComment)) return false;
    if (prevComment !== null && re.test(prevComment)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

/** Recursively collect .ts files, excluding tests and node_modules. */
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
        if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') {
          continue;
        }
        walk(fullPath);
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

function isRouteFile(absPath: string): boolean {
  const rel = relative(PROJECT_ROOT, absPath);
  return ROUTE_DIRS.some((dir) => rel.startsWith(dir));
}

function checkFile(filePath: string): Violation[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const violations: Violation[] = [];
  const relPath = relative(PROJECT_ROOT, filePath);
  const inRoute = isRouteFile(filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const matched = checkLine(line, {
      isRouteFile: inRoute,
      previousLine: i > 0 ? lines[i - 1] : undefined,
    });
    for (const pattern of matched) {
      violations.push({
        file: relPath,
        line: i + 1,
        text: line.trimStart(),
        pattern,
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function runCheck(): {
  passed: boolean;
  errors: number;
  violations: Violation[];
} {
  const c = getColors();
  console.log(
    `${c.blue}Checking for data-integrity anti-patterns (epic #4017)...${c.reset}\n`
  );

  const allFiles: string[] = [];
  for (const dir of SCAN_DIRS) {
    const absDir = join(PROJECT_ROOT, dir);
    allFiles.push(...collectTsFiles(absDir));
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
    console.log(
      `${c.green}No dangerous patterns found (${allFiles.length} files checked)${c.reset}`
    );
    return { passed: true, errors: 0, violations: [] };
  }

  // Group by pattern for cleaner output.
  const byPattern = new Map<PatternId, Violation[]>();
  for (const v of allViolations) {
    const list = byPattern.get(v.pattern) ?? [];
    list.push(v);
    byPattern.set(v.pattern, list);
  }

  console.log(
    `${c.red}Found ${allViolations.length} dangerous-pattern violation(s) across ${byPattern.size} pattern(s):${c.reset}\n`
  );

  for (const [pattern, vios] of byPattern) {
    const meta = PATTERN_META[pattern];
    console.log(`${c.red}● ${pattern}: ${meta.description}${c.reset}`);
    for (const v of vios) {
      console.log(`  ${c.red}${v.file}:${v.line}${c.reset}`);
      console.log(`    ${c.dim}${v.text}${c.reset}`);
    }
    console.log(`  ${c.dim}Fix: ${meta.fix}${c.reset}\n`);
  }

  return {
    passed: false,
    errors: allViolations.length,
    violations: allViolations,
  };
}

if (process.argv[1]?.includes('validate-dangerous-patterns')) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
