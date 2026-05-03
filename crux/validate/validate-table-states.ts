#!/usr/bin/env node

/**
 * Validate that data tables and directory pages use canonical loading / empty / error
 * components from `@/components/ui/table-states` instead of bespoke strings.
 *
 * Rationale (QUA-1008): every data table should render the same way for empty /
 * loading / error states. Today each table makes its own choice ("Loading…"
 * strings, spinners, raw `<div>Loading...</div>` Suspense fallbacks, etc.) which
 * is inconsistent and a frequent source of QA-sweep findings (QUA-916).
 *
 * Banned in `apps/web/src/app/**\/*-table.tsx` and `apps/web/src/app/**\/page.tsx`:
 *   - The literal "Loading..." (3 dots or unicode ellipsis) and "Loading <thing>..."
 *     phrases as JSX text or string literals.
 *
 * Allowed:
 *   - Imports from `@/components/ui/table-states` (the shared module).
 *   - Comments mentioning "Loading...".
 *   - Lines containing the canonical labels exported from `table-states.tsx`.
 *   - Lines explicitly annotated with `// table-states-ok: <reason>`.
 *
 * Usage: npx tsx crux/validate/validate-table-states.ts
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { PROJECT_ROOT } from "../lib/content-types.ts";
import { getColors } from "../lib/output.ts";

/** Files allowed to contain bespoke loading/empty/error strings (the shared module itself + tests). */
const ALLOWLIST = new Set<string>([
  "apps/web/src/components/ui/table-states.tsx",
  "apps/web/src/components/ui/__tests__/table-states.test.tsx",
]);

/** Directories scanned for *-table.tsx, *Table.tsx, and page.tsx files. */
const SCAN_ROOTS = ["apps/web/src/app", "apps/web/src/components"];

/**
 * Patterns banned outside the shared module. The regex matches "Loading..." and
 * "Loading <noun>..." with either three ASCII dots or the unicode ellipsis.
 */
const BANNED_PATTERNS: { name: string; regex: RegExp }[] = [
  {
    name: "bespoke 'Loading…' / 'Loading <thing>…' string",
    regex: /Loading(\s+[A-Za-z][A-Za-z\s]{0,40})?(\.{3}|…)/,
  },
];

interface Violation {
  file: string;
  line: number;
  text: string;
  pattern: string;
}

function isTargetFile(name: string): boolean {
  return (
    name.endsWith("-table.tsx") ||
    name.endsWith("Table.tsx") ||
    name === "page.tsx"
  );
}

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  function walk(current: string): void {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (entry === "node_modules" || entry === ".next") continue;
        walk(full);
        continue;
      }
      if (isTargetFile(entry)) out.push(full);
    }
  }
  walk(dir);
  return out;
}

function isComment(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  );
}

/** Match `from "@/components/ui/table-states"` with either quote style. */
const IMPORT_RE = /from\s+["']@\/components\/ui\/table-states["']/;
/**
 * Match a JSX call site for any of the canonical components. Must be followed
 * by whitespace, `/>`, or `>` to qualify as a real JSX element open — bare
 * `\b` lets `"<TableLoadingRow"` (a string literal) bypass.
 */
const CANONICAL_JSX_RE = /<(?:TableLoadingRow|TableEmptyRow|TableErrorRow|TableSkeleton|TableEmptyBlock|TableErrorBlock)(?:\s|\/?>)/;
/** Looser open-tag form used for multiline tracking (no immediate close required). */
const CANONICAL_JSX_OPEN_RE = /<(?:TableLoadingRow|TableEmptyRow|TableErrorRow|TableSkeleton|TableEmptyBlock|TableErrorBlock)\b/;
/**
 * Opt-out comment: requires a `//`, `/*`, or `{/*` comment marker followed by
 * a non-empty reason after `table-states-ok:`. Plain `"table-states-ok:"`
 * inside a string literal does NOT bypass — only an actual comment does.
 */
const OPT_OUT_RE = /(?:\/\/|\/\*|\{\/\*)\s*table-states-ok:\s+\S/;

/** Strip a trailing `// ...` comment so a banned literal in a comment doesn't false-flag. */
function stripTrailingLineComment(line: string): string {
  // Naive but adequate for our scan: find `//` not inside a string literal.
  // We accept some false negatives (banned literal lives inside a string after `//`)
  // — those are vanishingly rare and the regex still requires the literal text.
  const idx = line.indexOf("//");
  if (idx < 0) return line;
  // Don't strip if the `//` is inside a quoted string up to that point.
  const prefix = line.slice(0, idx);
  const dquoteCount = (prefix.match(/(?<!\\)"/g) ?? []).length;
  const squoteCount = (prefix.match(/(?<!\\)'/g) ?? []).length;
  if (dquoteCount % 2 === 1 || squoteCount % 2 === 1) return line;
  return prefix;
}

function checkFile(filePath: string): Violation[] {
  const relPath = relative(PROJECT_ROOT, filePath).replace(/\\/g, "/");
  if (ALLOWLIST.has(relPath)) return [];

  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const violations: Violation[] = [];

  // State carried across lines so multiline JSX block comments and multiline
  // canonical-element openings don't false-flag continuation lines that
  // contain the banned literal in attributes (e.g. `label="Loading users..."`).
  let inBlockComment = false; // inside `{/* ... */}` JSX block comment
  let inCanonicalElement = false; // inside `<TableLoadingRow ...>` spanning multiple lines

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];

    // Update block-comment state. We process opens and closes in order so a
    // single-line `{/* ... */}` (or `/* ... */`) toggles in and out within the
    // same iteration. Multi-line forms leave `inBlockComment` true until the
    // line containing `*/}` (or `*/`) is reached.
    let cursor = 0;
    let lineHasContentOutsideComment = false;
    while (cursor < rawLine.length) {
      if (inBlockComment) {
        const closeJsx = rawLine.indexOf("*/}", cursor);
        const closeC = rawLine.indexOf("*/", cursor);
        const close = closeJsx >= 0 && (closeC < 0 || closeJsx <= closeC) ? closeJsx + 3 : (closeC >= 0 ? closeC + 2 : -1);
        if (close < 0) {
          cursor = rawLine.length;
        } else {
          inBlockComment = false;
          cursor = close;
        }
      } else {
        const openJsx = rawLine.indexOf("{/*", cursor);
        const openC = rawLine.indexOf("/*", cursor);
        const open = openJsx >= 0 && (openC < 0 || openJsx <= openC) ? openJsx : openC;
        if (open < 0) {
          if (rawLine.slice(cursor).trim().length > 0) lineHasContentOutsideComment = true;
          cursor = rawLine.length;
        } else {
          if (rawLine.slice(cursor, open).trim().length > 0) lineHasContentOutsideComment = true;
          inBlockComment = true;
          cursor = open + (rawLine.startsWith("{/*", open) ? 3 : 2);
        }
      }
    }

    // If the entire line was inside a block comment (no content outside), skip it.
    if (!lineHasContentOutsideComment) continue;

    // Update canonical-element state.
    // Open: a multiline `<TableLoadingRow` etc. without an immediate `>` or `/>`
    // on the same line. Close: `>` or `/>` while we're tracking.
    if (!inCanonicalElement && CANONICAL_JSX_OPEN_RE.test(rawLine) && !CANONICAL_JSX_RE.test(rawLine)) {
      // Found `<TableLoadingRow` (or similar) but not the immediate-close form —
      // this is a multiline element. Skip the rest of the loop body and start tracking.
      // We still need to check this opening line for closure in case the open and
      // close are split by attributes on the same line ending in `>`.
      const closesOnSameLine = /[/>]>/.test(rawLine) || /\s>\s*$/.test(rawLine);
      inCanonicalElement = !closesOnSameLine;
      continue;
    }
    if (inCanonicalElement) {
      // Inside a canonical element body — skip until we see the closing `>` or `/>`.
      if (/\/?>/.test(rawLine)) inCanonicalElement = false;
      continue;
    }

    if (isComment(rawLine)) continue;
    // Skip lines that import from the canonical module.
    if (IMPORT_RE.test(rawLine)) continue;
    // Skip lines that invoke a canonical component as a JSX element.
    // `<TableLoadingRow ...>` etc. — the regex requires a real tag boundary,
    // so substring mentions in strings/comments don't bypass.
    if (CANONICAL_JSX_RE.test(rawLine)) continue;
    // Explicit opt-out — must be a `//` comment with a non-empty reason.
    // Accept either on this line or on the previous line (the comment-above-JSX form).
    if (OPT_OUT_RE.test(rawLine)) continue;
    const prev = i > 0 ? lines[i - 1] : "";
    if (OPT_OUT_RE.test(prev)) continue;
    // Strip trailing `//` comments before regex match so doc comments
    // mentioning the banned literal don't false-flag.
    const line = stripTrailingLineComment(rawLine);

    for (const { name, regex } of BANNED_PATTERNS) {
      const match = line.match(regex);
      if (match) {
        violations.push({
          file: relPath,
          line: i + 1,
          text: rawLine.trim(),
          pattern: name,
        });
        break;
      }
    }
  }

  return violations;
}

export function runCheck(opts: { roots?: string[]; quiet?: boolean } = {}): {
  passed: boolean;
  errors: number;
  violations: Violation[];
} {
  const c = getColors();
  const log = opts.quiet ? () => undefined : (m: string) => console.log(m);
  log(
    `${c.blue}Checking for bespoke table loading/empty/error states (QUA-1008)…${c.reset}\n`,
  );

  const roots = opts.roots ?? SCAN_ROOTS;
  const allFiles: string[] = [];
  for (const dir of roots) {
    const abs = dir.startsWith("/") ? dir : join(PROJECT_ROOT, dir);
    allFiles.push(...collectFiles(abs));
  }

  const all: Violation[] = [];
  for (const f of allFiles) all.push(...checkFile(f));

  if (all.length === 0) {
    log(
      `${c.green}No bespoke loading/empty/error states found (${allFiles.length} files checked)${c.reset}`,
    );
  } else {
    log(
      `${c.red}Found ${all.length} bespoke loading state(s) outside @/components/ui/table-states:${c.reset}\n`,
    );
    for (const v of all) {
      log(`  ${c.red}${v.file}:${v.line}${c.reset}`);
      log(`    ${c.dim}${v.text}${c.reset}`);
      log(
        `    ${c.dim}Fix: import { TableLoadingRow, TableSkeleton } from "@/components/ui/table-states"${c.reset}\n`,
      );
    }
  }

  return { passed: all.length === 0, errors: all.length, violations: all };
}

if (process.argv[1]?.includes("validate-table-states")) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
