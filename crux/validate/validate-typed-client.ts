#!/usr/bin/env node

/**
 * Validate that the codebase uses typed wiki-server client functions instead
 * of raw `apiRequest<T>` calls with hand-written type parameters.
 *
 * Per `.claude/rules/code-review-guidelines.md`:
 * "API callers must use typed wiki-server client functions
 *  (`crux/lib/wiki-server/*.ts`) — not raw `apiRequest<{...}>` with
 *  hand-written type parameters. If no typed client exists for the endpoint,
 *  create one using `InferResponseType<>`."
 *
 * Part of QUA-770 (Tier 5 of QUA-154 — Eliminate skipEntityValidation and
 * direct apiRequest bypasses). Also referenced in `.claude/rules/agent-session-workflow.md`
 * as "API callers match server response shape (use InferResponseType or typed client)".
 *
 * Pattern flagged:
 *   - `apiRequest<T>(...)` calls outside `crux/lib/wiki-server/` (the typed
 *     client modules). Hand-written type parameters lose `InferResponseType`
 *     benefits and drift from server response shapes.
 *
 * Suppression: `// typed-client-ok: <reason>` on the same line, or on a
 * comment-only line immediately above.
 *
 * Excluded:
 *   - `crux/lib/wiki-server/*.ts` — these ARE the typed clients
 *   - Test files (`__tests__/`, `*.test.ts`) — mocks and ad-hoc test fixtures
 *   - `node_modules/`, `dist/`
 *
 * Usage: npx tsx crux/validate/validate-typed-client.ts
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';

/** Directories to scan (relative to PROJECT_ROOT). */
const SCAN_DIRS = ['crux'];

/** Subpaths to exclude (relative to PROJECT_ROOT). The typed client modules
 *  themselves use `apiRequest<T>` internally — that's by design. */
const EXCLUDE_PATHS = ['crux/lib/wiki-server'];

const SUPPRESSION_MARKER = 'typed-client-ok';

interface Violation {
  file: string;
  line: number;
  text: string;
}

/**
 * `apiRequest<T>(...)` — raw apiRequest call with an explicit type parameter.
 *
 * The leading boundary `\b` prevents matching `batchedApiRequest`, etc.
 * The `<` after `apiRequest` is the type-parameter open; we don't try to
 * match the closing `>` because TypeScript generic types can be arbitrarily
 * complex (nested generics, object literals with commas, etc.). The `<`
 * immediately after `apiRequest` is sufficient to disambiguate from the
 * untyped `apiRequest(` form.
 *
 * Matches: `apiRequest<{ id: string }>`, `apiRequest<MyType>`, `await apiRequest<T>(`
 * Does NOT match: `apiRequest(` (untyped — also a problem, but flagged by
 *   a separate, narrower rule if/when added)
 * Does NOT match: `myApiRequest<T>` (different name)
 *
 * Used with a global flag so we can iterate matches and check each one's
 * position against string-literal state.
 */
const TYPED_API_REQUEST_PATTERN_G = /\bapiRequest\s*</g;

/**
 * Test whether a position in a line falls inside a string or template
 * literal. This prevents false positives when the validator (or any other
 * file) mentions the literal text `apiRequest<T>` in error messages or
 * documentation strings.
 *
 * Walks characters tracking quote/backtick state, identical in spirit to
 * `extractInlineComment` but stopping at the target index instead of at
 * the inline comment.
 *
 * Exported for unit tests.
 */
export function isInsideStringAt(line: string, index: number): boolean {
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  while (i < index && i < line.length) {
    const ch = line[i];
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
    }
    i++;
  }
  return inSingle || inDouble || inBacktick;
}

function buildSuppressionRegex(marker: string): RegExp {
  const escaped = marker.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\s*:\\s*\\S`);
}

const SUPPRESSION_REGEX = buildSuppressionRegex(SUPPRESSION_MARKER);

/**
 * Extract the inline comment portion of a line, ignoring `//` sequences
 * inside string or template literals. Mirrors the helper in
 * `validate-dangerous-patterns.ts`.
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
      else if (ch === '/' && next === '/') return line.slice(i + 2);
      else if (ch === '/' && next === '*') return line.slice(i + 2);
    }
    i++;
  }
  return null;
}

/**
 * Check a single line for the typed-client violation. Returns true if the
 * line contains a violation that is NOT suppressed.
 *
 * Exported for unit tests.
 */
export function lineHasViolation(
  line: string,
  options?: { previousLine?: string },
): boolean {
  const trimmed = line.trimStart();

  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
    return false;
  }

  // Find apiRequest<...> matches that are NOT inside a string literal.
  // The regex is reset each call (separate state per pattern test).
  const re = new RegExp(TYPED_API_REQUEST_PATTERN_G.source, 'g');
  let match: RegExpExecArray | null;
  let foundRealMatch = false;
  while ((match = re.exec(line)) !== null) {
    if (!isInsideStringAt(line, match.index)) {
      foundRealMatch = true;
      break;
    }
  }
  if (!foundRealMatch) return false;

  const inlineComment = extractInlineComment(line);
  if (inlineComment !== null && SUPPRESSION_REGEX.test(inlineComment)) {
    return false;
  }

  const prev = options?.previousLine?.trimStart() ?? '';
  const prevIsCommentOnly =
    prev.startsWith('//') || prev.startsWith('/*') || prev.startsWith('*');
  if (prevIsCommentOnly) {
    const prevComment = prev.replace(/^\/\/\s*|^\/\*\s*|^\*\s*/, '');
    if (SUPPRESSION_REGEX.test(prevComment)) return false;
  }

  return true;
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

function isExcluded(absPath: string): boolean {
  const rel = relative(PROJECT_ROOT, absPath);
  return EXCLUDE_PATHS.some((dir) => rel.startsWith(dir));
}

function checkFile(filePath: string): Violation[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const violations: Violation[] = [];
  const relPath = relative(PROJECT_ROOT, filePath);

  for (let i = 0; i < lines.length; i++) {
    if (lineHasViolation(lines[i], { previousLine: i > 0 ? lines[i - 1] : undefined })) {
      violations.push({
        file: relPath,
        line: i + 1,
        text: lines[i].trimStart(),
      });
    }
  }

  return violations;
}

export function runCheck(): {
  passed: boolean;
  errors: number;
  violations: Violation[];
} {
  const c = getColors();
  console.log(
    `${c.blue}Checking for direct apiRequest<T> calls (QUA-770)...${c.reset}\n`
  );

  const allFiles: string[] = [];
  for (const dir of SCAN_DIRS) {
    const absDir = join(PROJECT_ROOT, dir);
    allFiles.push(...collectTsFiles(absDir).filter((p) => !isExcluded(p)));
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
      `${c.green}No direct apiRequest<T> violations (${allFiles.length} files checked)${c.reset}`
    );
    return { passed: true, errors: 0, violations: [] };
  }

  console.log(
    `${c.red}Found ${allViolations.length} direct apiRequest<T> violation(s):${c.reset}\n`
  );
  console.log(
    `${c.dim}Hand-written apiRequest<T> calls bypass typed wiki-server client modules (crux/lib/wiki-server/*.ts)`
  );
  console.log(
    `and lose InferResponseType<> benefits. Either:`
  );
  console.log(
    `  1. Use an existing typed client function (preferred), or`
  );
  console.log(
    `  2. Create a new typed client module under crux/lib/wiki-server/, or`
  );
  console.log(
    `  3. Add \`// typed-client-ok: <reason>\` on the same line if direct typing is intentional${c.reset}\n`
  );

  for (const v of allViolations) {
    console.log(`  ${c.red}${v.file}:${v.line}${c.reset}`);
    console.log(`    ${c.dim}${v.text}${c.reset}`);
  }

  return {
    passed: false,
    errors: allViolations.length,
    violations: allViolations,
  };
}

if (process.argv[1]?.includes('validate-typed-client')) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
