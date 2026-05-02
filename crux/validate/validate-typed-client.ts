#!/usr/bin/env node

/**
 * Validate that the codebase uses typed wiki-server client functions instead
 * of raw `apiRequest<T>` calls with hand-written type parameters.
 *
 * Per the `/agent-review-pr` skill body ("Code review rules to enforce"):
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

import { readFileSync } from 'fs';
import { join, relative } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';
import {
  findInlineCommentStart,
  isInsideStringAt,
  buildSuppressionRegex,
} from './lib/comment-utils.ts';
import { collectTsFiles } from './lib/file-walker.ts';

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
 * Known limitation: only matches when `apiRequest<` is on the same line.
 * A multi-line form like `apiRequest\n<T>(` is not detected. The current
 * codebase formatter never produces this form; if it ever appears, fall
 * back to a stricter AST-based detector.
 *
 * Used with a global flag so we can iterate matches and check each one's
 * position against string-literal state.
 */
const TYPED_API_REQUEST_PATTERN_G = /\bapiRequest\s*</g;

const SUPPRESSION_REGEX = buildSuppressionRegex(SUPPRESSION_MARKER);

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

  // Find apiRequest<...> matches that are real code: not inside an inline
  // comment, not inside a string literal. Skipping matches past the comment
  // opener avoids false positives like `foo(); // see apiRequest<T> docs`.
  const commentStart = findInlineCommentStart(line);
  let foundRealMatch = false;
  for (const match of line.matchAll(TYPED_API_REQUEST_PATTERN_G)) {
    const idx = match.index ?? 0;
    if (commentStart !== -1 && idx >= commentStart) continue;
    if (!isInsideStringAt(line, idx)) {
      foundRealMatch = true;
      break;
    }
  }
  if (!foundRealMatch) return false;

  // Reuse `commentStart` to extract the inline comment without a second walk.
  const inlineComment = commentStart === -1 ? null : line.slice(commentStart + 2);
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

function checkFile(filePath: string, projectRoot: string = PROJECT_ROOT): Violation[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const violations: Violation[] = [];
  const relPath = relative(projectRoot, filePath);

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

export interface RunCheckOptions {
  /** Override scan directories (relative to projectRoot). Defaults to `SCAN_DIRS`. */
  scanDirs?: readonly string[];
  /** Override exclude paths (relative to projectRoot). Defaults to `EXCLUDE_PATHS`. */
  excludePaths?: readonly string[];
  /** Override project root. Defaults to repo `PROJECT_ROOT`. */
  projectRoot?: string;
  /** Suppress console output (useful for tests). */
  silent?: boolean;
}

export function runCheck(opts: RunCheckOptions = {}): {
  passed: boolean;
  errors: number;
  violations: Violation[];
} {
  const c = getColors();
  const scanDirs = opts.scanDirs ?? SCAN_DIRS;
  const excludePaths = opts.excludePaths ?? EXCLUDE_PATHS;
  const projectRoot = opts.projectRoot ?? PROJECT_ROOT;
  const log = opts.silent ? () => {} : console.log;

  log(`${c.blue}Checking for direct apiRequest<T> calls (QUA-770)...${c.reset}\n`);

  const isExcludedHere = (absPath: string): boolean => {
    const rel = relative(projectRoot, absPath);
    return excludePaths.some((dir) => rel.startsWith(dir));
  };

  const allFiles: string[] = [];
  for (const dir of scanDirs) {
    const absDir = join(projectRoot, dir);
    allFiles.push(
      ...collectTsFiles(absDir, { includeTsx: true }).filter((p) => !isExcludedHere(p)),
    );
  }

  if (allFiles.length === 0) {
    log(`${c.dim}No files found to check${c.reset}`);
    return { passed: true, errors: 0, violations: [] };
  }

  const allViolations: Violation[] = [];
  for (const file of allFiles) {
    allViolations.push(...checkFile(file, projectRoot));
  }

  if (allViolations.length === 0) {
    log(`${c.green}No direct apiRequest<T> violations (${allFiles.length} files checked)${c.reset}`);
    return { passed: true, errors: 0, violations: [] };
  }

  log(`${c.red}Found ${allViolations.length} direct apiRequest<T> violation(s):${c.reset}\n`);
  log(`${c.dim}Hand-written apiRequest<T> calls bypass typed wiki-server client modules (crux/lib/wiki-server/*.ts)`);
  log(`and lose InferResponseType<> benefits. Either:`);
  log(`  1. Use an existing typed client function (preferred), or`);
  log(`  2. Create a new typed client module under crux/lib/wiki-server/, or`);
  log(`  3. Add \`// typed-client-ok: <reason>\` on the same line if direct typing is intentional${c.reset}\n`);

  for (const v of allViolations) {
    log(`  ${c.red}${v.file}:${v.line}${c.reset}`);
    log(`    ${c.dim}${v.text}${c.reset}`);
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
