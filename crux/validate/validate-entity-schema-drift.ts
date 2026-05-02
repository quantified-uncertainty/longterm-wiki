#!/usr/bin/env node

/**
 * Entity-schema drift validator.
 *
 * Bans new `const VALID_*` declarations and inline `z.enum([...])` literals in
 * apps/wiki-server/src/routes/tablebase/ — both are markers of an entity wire
 * schema being hand-written in a sync route instead of imported from a
 * canonical shared schema.
 *
 * The current baseline of files containing drift markers is recorded in
 * .entity-schema-drift-allowlist.txt. The validator fails if a NEW route adds
 * drift markers without being added to the allowlist — preventing new drift
 * from accumulating. Existing entries can be removed when a route is migrated
 * to a shared schema, but there is no active plan driving the allowlist to
 * zero (the QUA-943 v5 plan that originally drove this was rejected — see
 * QUA-1043). Treat this as standalone hygiene against new drift, not as a
 * migration progress meter.
 *
 * Suppression: add `// schema-drift-ok: <reason>` on the same line. The
 * reason is mandatory (matches the buildSuppressionRegex contract used by
 * other validators).
 *
 * Usage:
 *   npx tsx crux/validate/validate-entity-schema-drift.ts            # check
 *   npx tsx crux/validate/validate-entity-schema-drift.ts --update   # rewrite allowlist
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';
import {
  buildSuppressionRegex,
  findInlineCommentStart,
  isInsideStringAt,
} from './lib/comment-utils.ts';
import { collectTsFiles } from './lib/file-walker.ts';

const TABLEBASE_ROUTES_DIR = join(PROJECT_ROOT, 'apps/wiki-server/src/routes/tablebase');
const ALLOWLIST_PATH = join(PROJECT_ROOT, 'crux/validate/.entity-schema-drift-allowlist.txt');
const SUPPRESSION_MARKER = 'schema-drift-ok';
const SUPPRESSION_REGEX = buildSuppressionRegex(SUPPRESSION_MARKER);

type Kind = 'VALID_CONST' | 'INLINE_ENUM';

/**
 * Patterns shared between single-line and multi-line passes. The `\s*` after
 * `z.enum(` is harmless on the single-line case and lets the joined-line
 * pass catch formatter-induced splits like `z.enum(\n  [...])`.
 */
const PATTERNS: Array<{ globalPattern: RegExp; kind: Kind }> = [
  { globalPattern: /\bconst\s+VALID_[A-Z_]+\s*=/g, kind: 'VALID_CONST' },
  { globalPattern: /z\.enum\(\s*\[/g, kind: 'INLINE_ENUM' },
];

export interface Violation {
  line: number;
  text: string;
  kind: Kind;
}

function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function lineIsSuppressed(line: string): boolean {
  if (!line.includes(SUPPRESSION_MARKER)) return false;
  const commentStart = findInlineCommentStart(line);
  if (commentStart === -1) return false;
  return SUPPRESSION_REGEX.test(line.slice(commentStart + 2));
}

/**
 * Run all patterns against `line`, filtering out matches that fall inside a
 * string literal. Returns the kind of the first real match, or null.
 *
 * Exported for unit tests.
 */
export function checkLine(line: string): Kind | null {
  if (isCommentLine(line.trimStart())) return null;
  if (lineIsSuppressed(line)) return null;
  const commentStart = findInlineCommentStart(line);
  for (const { globalPattern, kind } of PATTERNS) {
    for (const match of line.matchAll(globalPattern)) {
      const idx = match.index ?? 0;
      if (commentStart !== -1 && idx >= commentStart) continue;
      if (isInsideStringAt(line, idx)) continue;
      return kind;
    }
  }
  return null;
}

function checkFile(filePath: string, baseDir: string): { relPath: string; violations: Violation[] } {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const violations: Violation[] = [];
  const relPath = relative(baseDir, filePath);
  for (let i = 0; i < lines.length; i++) {
    const kind = checkLine(lines[i]);
    if (kind) {
      violations.push({ line: i + 1, text: lines[i].trimStart(), kind });
      continue;
    }
    // Multi-line pass: catches formatter-induced splits like
    // `const VALID_X\n  = [...]` or `z.enum(\n  ["a"])`. Use checkLine
    // semantics on the joined line so string-literal / comment / suppression
    // filters apply (raw `pattern.test` would mis-fire on string literals
    // that contain example code, and on a comment-then-real-code pair).
    if (i + 1 >= lines.length) continue;
    if (isCommentLine(lines[i].trimStart())) continue;
    const nextLine = lines[i + 1];
    const nextTrim = nextLine.trimStart();
    if (isCommentLine(nextTrim)) continue;
    if (lineIsSuppressed(nextLine)) continue;
    const joined = lines[i].trimEnd() + ' ' + nextTrim;
    const joinedKind = checkLine(joined);
    if (joinedKind !== null) {
      violations.push({
        line: i + 1,
        text: `${lines[i].trimStart()} ${nextTrim}`.trim(),
        kind: joinedKind,
      });
    }
  }
  return { relPath, violations };
}

export function readAllowlist(path: string = ALLOWLIST_PATH): Set<string> {
  const allowed = new Set<string>();
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    return allowed;
  }
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    allowed.add(line);
  }
  return allowed;
}

interface CheckResult {
  passed: boolean;
  errors: number;
  newViolations: Array<Violation & { file: string }>;
  staleEntries: string[];
  allowlistedFileCount: number;
  fileCountWithDrift: number;
}

export function runCheck(
  opts: { rootDir?: string; allowlistPath?: string; baseDir?: string; updateBaseline?: boolean } = {},
): CheckResult {
  const c = getColors();
  const rootDir = opts.rootDir ?? TABLEBASE_ROUTES_DIR;
  const allowlistPath = opts.allowlistPath ?? ALLOWLIST_PATH;
  const baseDir = opts.baseDir ?? PROJECT_ROOT;

  console.log(`${c.blue}Checking entity-schema drift in ${relative(baseDir, rootDir)}/...${c.reset}\n`);

  if (!existsSync(rootDir)) {
    console.log(`${c.dim}Skipping: ${rootDir} not found${c.reset}`);
    return {
      passed: true, errors: 0, newViolations: [], staleEntries: [],
      allowlistedFileCount: 0, fileCountWithDrift: 0,
    };
  }
  const allFiles = collectTsFiles(rootDir);

  const filesWithDrift = new Map<string, Violation[]>();
  for (const file of allFiles) {
    const { relPath, violations } = checkFile(file, baseDir);
    if (violations.length > 0) filesWithDrift.set(relPath, violations);
  }

  if (opts.updateBaseline) {
    const sorted = [...filesWithDrift.keys()].sort();
    let existing: string;
    try {
      existing = readFileSync(allowlistPath, 'utf-8');
    } catch {
      existing = '';
    }
    // Preserve only the leading run of comment/blank lines as the header.
    // A scan that keeps comments and blanks anywhere in the file would mix
    // gaps between entries into the header and reorder them.
    const headerLines: string[] = [];
    for (const line of existing.split('\n')) {
      if (line.startsWith('#') || line.trim() === '') {
        headerLines.push(line);
      } else {
        break;
      }
    }
    // Always normalize the header to end in exactly one `\n`. Without this,
    // a header whose last line is a comment (no trailing blank) would be
    // glued to the first allowlist entry on `header + body` concatenation,
    // silently corrupting the file (the next `readAllowlist` call would
    // treat the merged line as a comment and drop the first entry).
    const header = headerLines.length > 0
      ? headerLines.join('\n').replace(/\n+$/, '') + '\n'
      : '';
    const body = sorted.join('\n') + '\n';
    writeFileSync(allowlistPath, header + body);
    console.log(`${c.green}Wrote ${sorted.length} entries to ${relative(baseDir, allowlistPath)}${c.reset}`);
    return {
      passed: true, errors: 0, newViolations: [], staleEntries: [],
      allowlistedFileCount: sorted.length, fileCountWithDrift: sorted.length,
    };
  }

  const allowed = readAllowlist(allowlistPath);
  const newViolations: Array<Violation & { file: string }> = [];
  for (const [file, vs] of filesWithDrift) {
    if (!allowed.has(file)) {
      for (const v of vs) newViolations.push({ ...v, file });
    }
  }

  const staleEntries: string[] = [];
  for (const entry of allowed) {
    if (!filesWithDrift.has(entry)) staleEntries.push(entry);
  }

  const errors = newViolations.length + staleEntries.length;
  if (errors === 0) {
    console.log(`${c.green}No entity-schema drift outside allowlist (${filesWithDrift.size} files allowlisted, ${allFiles.length} files scanned)${c.reset}`);
    if (filesWithDrift.size > 0) {
      console.log(`${c.dim}${filesWithDrift.size} file(s) on the allowlist (no active plan to drive this to zero — see QUA-1043).${c.reset}`);
    }
  } else {
    if (newViolations.length > 0) {
      const fileCount = new Set(newViolations.map(v => v.file)).size;
      console.log(`${c.red}Found ${newViolations.length} drift marker(s) in ${fileCount} non-allowlisted file(s):${c.reset}\n`);
      for (const v of newViolations) {
        console.log(`  ${c.red}${v.file}:${v.line}${c.reset} [${v.kind}]`);
        console.log(`    ${c.dim}${v.text}${c.reset}`);
      }
      console.log(`\n${c.dim}Fix: import the schema from a shared canonical location instead of hand-writing it in the route.${c.reset}`);
      console.log(`${c.dim}Suppress a single legitimate use (e.g., query-string enum): add \`// ${SUPPRESSION_MARKER}: <reason>\` on the same line.${c.reset}`);
      console.log(`${c.dim}If migration to canonical schemas is not yet possible, add the file to ${relative(PROJECT_ROOT, allowlistPath)}.${c.reset}\n`);
    }
    if (staleEntries.length > 0) {
      console.log(`${c.yellow}${staleEntries.length} stale allowlist entr${staleEntries.length === 1 ? 'y' : 'ies'} (file no longer contains drift markers — please remove):${c.reset}`);
      for (const entry of staleEntries) console.log(`  ${c.yellow}${entry}${c.reset}`);
      console.log(`\n${c.dim}Update with: npx tsx crux/validate/validate-entity-schema-drift.ts --update${c.reset}\n`);
    }
  }

  return {
    passed: errors === 0,
    errors,
    newViolations,
    staleEntries,
    allowlistedFileCount: allowed.size,
    fileCountWithDrift: filesWithDrift.size,
  };
}

const __isMain = process.argv[1]?.endsWith('validate-entity-schema-drift.ts');
if (__isMain) {
  const updateBaseline = process.argv.includes('--update');
  const result = runCheck({ updateBaseline });
  process.exit(result.passed ? 0 : 1);
}
