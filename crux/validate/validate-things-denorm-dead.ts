#!/usr/bin/env -S npx tsx
/**
 * QUA-507: Blocks any future code from reintroducing the denormalized
 * `things.title` / `things.description` / `things.parent_title` columns
 * that were dropped in migration 0204.
 *
 * Scans `apps/wiki-server/src/**\/*.ts` (excluding the shared helper
 * `routes/shared/thing-sync.ts` whose comments may reference the
 * historical column names) for:
 *   1. **Drizzle column access**: `things.title`, `things.description`,
 *      `things.parentTitle`. Does NOT match `thingsSearch.title` (the MV
 *      column that replaced them).
 *   2. **Raw SQL reads**: `FROM things` / `JOIN things` (with any alias)
 *      combined with a reference to `<alias>.title` /
 *      `<alias>.description` / `<alias>.parent_title` elsewhere in the
 *      same template-literal block. Scanned multi-line.
 *
 * Allowlist: append `// things-denorm-dead-ok` to the offending line
 * (Drizzle) or anywhere inside the template literal (raw SQL).
 *
 * Usage:
 *   npx tsx crux/validate/validate-things-denorm-dead.ts
 */

import { readFileSync } from "fs";
import { join, relative } from "path";
import { findFiles } from "../lib/file-utils.ts";
import { getLineNumber } from "../lib/mdx-utils.ts";
import { PROJECT_ROOT } from "../lib/content-types.ts";

const SCAN_ROOT = join(PROJECT_ROOT, "apps/wiki-server/src");
const ALLOW_MARKER = "things-denorm-dead-ok";

// Drizzle-style column access: `things.title`, `things.description`,
// `things.parentTitle`. Negative lookbehind excludes identifiers like
// `thingsSearch` or `customThings`.
const DRIZZLE_COL_RE = /(?<![A-Za-z_])things\.(title|description|parentTitle)\b/;

// Backtick-delimited template literal (no nested templates).
const TEMPLATE_RE = /`(?:[^`\\]|\\.)*`/g;

// `FROM things` / `JOIN things` with optional alias. Negative lookahead
// `(?!_search)` prevents matching the `things_search` MV.
const FROM_THINGS_ALIAS_RE =
  /\b(?:FROM|JOIN)\s+things\b(?!_search)(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi;

interface Violation {
  file: string;
  line: number;
  text: string;
  reason: string;
}

const DRIZZLE_REASON =
  "Drizzle access to things.title/description/parentTitle (dropped in migration 0204). Read from thingsSearch instead.";
const RAW_SQL_REASON =
  "Raw SQL reading <alias>.title/description/parent_title from the `things` table (dropped in migration 0204). Read from things_search MV instead.";

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  );
}

function scanDrizzle(rel: string, source: string, violations: Violation[]): void {
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(ALLOW_MARKER) || isCommentLine(line)) continue;
    if (!DRIZZLE_COL_RE.test(line)) continue;
    violations.push({
      file: rel,
      line: i + 1,
      text: line.trim().slice(0, 160),
      reason: DRIZZLE_REASON,
    });
  }
}

function scanRawSql(rel: string, source: string, violations: Violation[]): void {
  TEMPLATE_RE.lastIndex = 0;
  let templateMatch: RegExpExecArray | null;
  while ((templateMatch = TEMPLATE_RE.exec(source)) !== null) {
    const body = templateMatch[0];
    const startOffset = templateMatch.index;
    if (body.includes(ALLOW_MARKER)) continue;

    const aliases: string[] = [];
    FROM_THINGS_ALIAS_RE.lastIndex = 0;
    let fm: RegExpExecArray | null;
    while ((fm = FROM_THINGS_ALIAS_RE.exec(body)) !== null) {
      aliases.push(fm[1] ?? "things");
    }
    if (aliases.length === 0) continue;

    for (const alias of aliases) {
      const re = new RegExp(
        `\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(title|description|parent_title)\\b`,
      );
      const colMatch = body.match(re);
      if (!colMatch) continue;
      const insideOffset = body.indexOf(colMatch[0]);
      violations.push({
        file: rel,
        line: getLineNumber(source, startOffset + insideOffset),
        text: colMatch[0],
        reason: RAW_SQL_REASON,
      });
    }
  }
}

export function runCheck(): { passed: boolean; violations: Violation[] } {
  const violations: Violation[] = [];
  const files = findFiles(SCAN_ROOT, [".ts"]).filter((f) => !f.endsWith(".d.ts"));

  for (const file of files) {
    const rel = relative(PROJECT_ROOT, file);
    if (rel.endsWith("/routes/shared/thing-sync.ts")) continue;
    const source = readFileSync(file, "utf-8");
    scanDrizzle(rel, source, violations);
    scanRawSql(rel, source, violations);
  }

  return { passed: violations.length === 0, violations };
}

function main(): void {
  const { passed, violations } = runCheck();
  if (passed) {
    console.log("validate-things-denorm-dead: pass (0 violations)");
    process.exit(0);
  }
  console.error(`validate-things-denorm-dead: FAIL (${violations.length} violation(s))`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} — ${v.reason}`);
    console.error(`    ${v.text}`);
  }
  console.error("");
  console.error("QUA-507 dropped things.title / things.description / things.parent_title.");
  console.error("Read display fields from the `things_search` MV (apps/wiki-server/src/schema.ts::thingsSearch).");
  console.error("To suppress a known-safe reference, append `// things-denorm-dead-ok`.");
  process.exit(1);
}

if (process.argv[1]?.includes("validate-things-denorm-dead")) {
  main();
}
