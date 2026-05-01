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

function checkFile(filePath: string): Violation[] {
  const relPath = relative(PROJECT_ROOT, filePath).replace(/\\/g, "/");
  if (ALLOWLIST.has(relPath)) return [];

  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const violations: Violation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isComment(line)) continue;
    // Skip lines that import from the canonical module — they're allowed.
    if (line.includes("from \"@/components/ui/table-states\"")) continue;
    if (line.includes("from '@/components/ui/table-states'")) continue;
    // Skip lines that invoke the canonical components directly. Their `label`
    // / `message` props legitimately contain the "Loading…" string.
    if (
      line.includes("<TableLoadingRow") ||
      line.includes("<TableEmptyRow") ||
      line.includes("<TableErrorRow") ||
      line.includes("<TableSkeleton") ||
      line.includes("<TableEmptyBlock") ||
      line.includes("<TableErrorBlock")
    ) {
      continue;
    }
    // Skip lines with explicit override (or with override on previous line).
    if (line.includes("table-states-ok:")) continue;
    const prev = i > 0 ? lines[i - 1] : "";
    if (prev.includes("table-states-ok:")) continue;

    for (const { name, regex } of BANNED_PATTERNS) {
      const match = line.match(regex);
      if (match) {
        violations.push({
          file: relPath,
          line: i + 1,
          text: line.trim(),
          pattern: name,
        });
        break;
      }
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
    `${c.blue}Checking for bespoke table loading/empty/error states (QUA-1008)…${c.reset}\n`,
  );

  const allFiles: string[] = [];
  for (const dir of SCAN_ROOTS) {
    const abs = join(PROJECT_ROOT, dir);
    allFiles.push(...collectFiles(abs));
  }

  const all: Violation[] = [];
  for (const f of allFiles) all.push(...checkFile(f));

  if (all.length === 0) {
    console.log(
      `${c.green}No bespoke loading/empty/error states found (${allFiles.length} files checked)${c.reset}`,
    );
  } else {
    console.log(
      `${c.red}Found ${all.length} bespoke loading state(s) outside @/components/ui/table-states:${c.reset}\n`,
    );
    for (const v of all) {
      console.log(`  ${c.red}${v.file}:${v.line}${c.reset}`);
      console.log(`    ${c.dim}${v.text}${c.reset}`);
      console.log(
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
