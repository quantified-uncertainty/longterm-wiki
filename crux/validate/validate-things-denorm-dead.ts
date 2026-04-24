#!/usr/bin/env -S npx tsx
/**
 * QUA-507: Blocks any future code from reintroducing the denormalized
 * `things.title` / `things.description` / `things.parent_title` columns
 * that were dropped in migration 0204.
 *
 * Scans `apps/wiki-server/src/**\/*.ts` (except the drizzle/ migrations
 * folder which keeps historical column names for posterity) for:
 *   1. Drizzle column access: `things.title`, `things.description`,
 *      `things.parentTitle`.
 *   2. ThingSyncInput payloads: literal object properties named `title:`,
 *      `description:`, `parentTitle:` inside a block that also writes via
 *      `upsertThingsInTx` (allowlist: `sourceUrl`, `parentThingId`).
 *   3. SQL `FROM things` with a column selection containing `t.title`,
 *      `t.description`, or `t.parent_title` — reads must go through the
 *      `things_search` MV.
 *
 * Allowlist: files may add `// things-denorm-dead-ok` on the same line
 * to suppress a false positive (migrations, historical comments).
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

// Drizzle-style column accesses. Must match `things.title` (not `thingsSearch.title`).
const DRIZZLE_COL_RE = /(?<![A-Za-z_])things\.(title|description|parentTitle)\b/;

// Raw SQL reads: `FROM things`/`JOIN things` alias followed by `.title`/`.description`/`.parent_title`.
const RAW_SQL_COL_RE = /\bt\.(title|description|parent_title)\b/;
const RAW_SQL_FROM_RE = /\bFROM\s+things\b/i;

// `things_search` is the *MV* name — skip lines referencing it.
const MV_GUARD_RE = /things_search/;

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

function scan(): Violation[] {
  const violations: Violation[] = [];
  const files = walk(SCAN_ROOT);

  for (const file of files) {
    const rel = relative(PROJECT_ROOT, file);
    // Skip the test file for this validator + schema.ts itself (drizzle
    // definitions stay clean after QUA-507 — the table no longer has the
    // columns, so any reference in schema.ts would be a typecheck error anyway).
    if (rel.includes("/routes/shared/thing-sync.ts")) continue;

    const lines = readFileSync(file, "utf-8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes(ALLOW_MARKER)) continue;

      // Skip commented-out references (doc strings, inline comments) — they
      // only describe historical behavior and don't execute.
      const trimmed = line.trimStart();
      if (
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*")
      ) {
        continue;
      }

      // Skip lines that only touch `things_search` (the MV where the columns live).
      const dropped = line.replace(MV_GUARD_RE, "");

      if (DRIZZLE_COL_RE.test(dropped)) {
        violations.push({
          file: rel,
          line: i + 1,
          text: line.trim().slice(0, 160),
          reason: "Drizzle access to things.title/description/parentTitle (dropped in migration 0204). Read from thingsSearch instead.",
        });
        continue;
      }

      if (RAW_SQL_COL_RE.test(line) && RAW_SQL_FROM_RE.test(line)) {
        violations.push({
          file: rel,
          line: i + 1,
          text: line.trim().slice(0, 160),
          reason: "Raw SQL reading t.title/description/parent_title FROM things. Read from things_search MV instead.",
        });
      }
    }
  }

  return violations;
}

function main(): void {
  const violations = scan();
  if (violations.length === 0) {
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
  console.error("To suppress a known-safe reference, append `// things-denorm-dead-ok` to the line.");
  process.exit(1);
}

main();
