#!/usr/bin/env -S npx tsx
/**
 * QUA-507: Blocks any future code from reintroducing the denormalized
 * `things.title` / `things.description` / `things.parent_title` columns
 * that were dropped in migration 0204.
 *
 * Scans `apps/wiki-server/src/**\/*.ts` (except `drizzle/` migrations
 * and this file's own test) for:
 *   1. **Drizzle column access**: `things.title`, `things.description`,
 *      `things.parentTitle`. Does NOT match `thingsSearch.title` (the MV
 *      column that replaced them).
 *   2. **Raw SQL reads**: `FROM things` / `JOIN things` (with any alias)
 *      combined with a reference to `<alias>.title` /
 *      `<alias>.description` / `<alias>.parent_title` elsewhere in the
 *      same template-literal block. Scanned multi-line so `FROM` on one
 *      line and `t.title` on another both count.
 *
 * Allowlist: append `// things-denorm-dead-ok` to the offending line.
 * Commented code (lines whose trimmed prefix is `*`, `//`, or `/*`) is
 * skipped for Drizzle matches; raw-SQL matches live inside template
 * literals so comment-skipping doesn't apply there.
 *
 * Usage:
 *   npx tsx crux/validate/validate-things-denorm-dead.ts
 *
 * Exit 0 = passed, 1 = violations found.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, resolve } from "path";

const PROJECT_ROOT = resolve(new URL(".", import.meta.url).pathname, "../..");
const SCAN_ROOT = join(PROJECT_ROOT, "apps/wiki-server/src");

const ALLOW_MARKER = "things-denorm-dead-ok";

interface Violation {
  file: string;
  line: number;
  text: string;
  reason: string;
}

// Drizzle-style column access: `things.title`, `things.description`,
// `things.parentTitle`. Negative lookbehind excludes identifiers like
// `thingsSearch` or `customThings`.
const DRIZZLE_COL_RE = /(?<![A-Za-z_])things\.(title|description|parentTitle)\b/;

// Raw SQL: any template literal that references `FROM things` (or
// `JOIN things`) and also references `<alias>.(title|description|parent_title)`.
// Captured by finding a `FROM/JOIN things <alias>` declaration, then
// searching the same literal for `<alias>.(title|description|parent_title)`.
//
// We scan template literals because raw SQL is almost always written in
// backtick-delimited multi-line strings.
const TEMPLATE_RE = /`([^`\\]|\\.)*`/g;
const FROM_THINGS_ALIAS_RE =
  /\b(?:FROM|JOIN)\s+things\b(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?\b(?!_search)/gi;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "drizzle" || name === ".drizzle") {
        continue;
      }
      walk(full, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function scanDrizzleLine(
  file: string,
  rel: string,
  line: string,
  lineNum: number,
): Violation | null {
  if (line.includes(ALLOW_MARKER)) return null;

  // Skip commented lines — they describe historical behavior.
  const trimmed = line.trimStart();
  if (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  ) {
    return null;
  }

  if (!DRIZZLE_COL_RE.test(line)) return null;

  return {
    file: rel,
    line: lineNum,
    text: line.trim().slice(0, 160),
    reason:
      "Drizzle access to things.title/description/parentTitle (dropped in migration 0204). Read from thingsSearch instead.",
  };
}

interface TemplateMatch {
  body: string;
  startOffset: number;
}

function extractTemplates(source: string): TemplateMatch[] {
  const matches: TemplateMatch[] = [];
  TEMPLATE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TEMPLATE_RE.exec(source)) !== null) {
    matches.push({ body: m[0], startOffset: m.index });
  }
  return matches;
}

function lineNumberAtOffset(source: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") n++;
  }
  return n;
}

function scanRawSql(
  rel: string,
  source: string,
): Violation[] {
  const violations: Violation[] = [];
  for (const { body, startOffset } of extractTemplates(source)) {
    if (body.includes(ALLOW_MARKER)) continue;

    // Collect every alias introduced by `FROM things [alias]` / `JOIN things [alias]`.
    // The negative lookahead `(?!_search)` prevents matching `things_search`.
    const aliases: string[] = [];
    let fm: RegExpExecArray | null;
    FROM_THINGS_ALIAS_RE.lastIndex = 0;
    while ((fm = FROM_THINGS_ALIAS_RE.exec(body)) !== null) {
      aliases.push(fm[1] ?? "things");
    }

    if (aliases.length === 0) continue;

    // Check whether any alias's .(title|description|parent_title) is used
    // elsewhere in the body.
    for (const alias of aliases) {
      const re = new RegExp(
        `\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(title|description|parent_title)\\b`,
      );
      if (!re.test(body)) continue;

      // Locate the alias reference for a meaningful line number.
      const aliasMatch = body.match(re)!;
      const insideOffset = body.indexOf(aliasMatch[0]);
      const absoluteOffset = startOffset + insideOffset;
      const lineNum = lineNumberAtOffset(source, absoluteOffset);

      violations.push({
        file: rel,
        line: lineNum,
        text: aliasMatch[0],
        reason:
          "Raw SQL reading <alias>.title/description/parent_title from the `things` table (dropped in migration 0204). Read from things_search MV instead.",
      });
    }
  }
  return violations;
}

function scan(): Violation[] {
  const violations: Violation[] = [];
  const files = walk(SCAN_ROOT);

  for (const file of files) {
    const rel = relative(PROJECT_ROOT, file);
    // Skip the shared helper itself — its own comments may reference the
    // historical column names.
    if (rel.includes("/routes/shared/thing-sync.ts")) continue;

    const source = readFileSync(file, "utf-8");

    // Per-line Drizzle scan.
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const v = scanDrizzleLine(file, rel, lines[i], i + 1);
      if (v) violations.push(v);
    }

    // Template-literal SQL scan.
    violations.push(...scanRawSql(rel, source));
  }

  return violations;
}

function main(): void {
  const violations = scan();
  if (violations.length === 0) {
    console.log("validate-things-denorm-dead: pass (0 violations)");
    process.exit(0);
  }

  console.error(
    `validate-things-denorm-dead: FAIL (${violations.length} violation(s))`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} — ${v.reason}`);
    console.error(`    ${v.text}`);
  }
  console.error("");
  console.error(
    "QUA-507 dropped things.title / things.description / things.parent_title.",
  );
  console.error(
    "Read display fields from the `things_search` MV (apps/wiki-server/src/schema.ts::thingsSearch).",
  );
  console.error(
    "To suppress a known-safe reference, append `// things-denorm-dead-ok` to the line (for Drizzle) or inside the template literal (for raw SQL).",
  );
  process.exit(1);
}

main();
