#!/usr/bin/env node

/**
 * Block the non-word "sourcinged" from re-entering user-visible strings.
 *
 * QUA-237 mass-renamed legacy verification terminology to the "sourcing"
 * vocabulary. Because the rename was a mechanical substring replace, the
 * past-participle form "...checked" was turned into "...inged" in five
 * places, including the /divisions header. QUA-897 corrected the typos.
 * This validator catches a regression if a future rename re-introduces
 * the artifact.
 *
 * Scoped to user-visible content surfaces (TS/TSX/MDX/YAML). The dist/
 * `.next/`, `node_modules/`, and `.cache/` trees are skipped.
 *
 * Usage: npx tsx crux/validate/validate-no-sourcinged.ts
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { PROJECT_ROOT } from "../lib/content-types.ts";
import { getColors } from "../lib/output.ts";

const SCAN_DIRS = ["apps/web/src", "apps/wiki-server/src", "content", "crux"];
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".cache",
  "dist",
  "playwright-report",
  "test-results",
]);
// .json intentionally omitted: build outputs (database.json, factbase-data.json)
// are generated and not edited by hand. .md is omitted because user-visible
// content lives in .mdx; .md files outside this validator's scope are docs.
const SCAN_EXTENSIONS = [".ts", ".tsx", ".mdx", ".yaml", ".yml"];
const BANNED = "sourcinged";

// Path-equality allowlist (relative to PROJECT_ROOT) for files that must
// reference the banned string by name (the validator itself, its test, and
// the gate registry entry that points at it).
const ALLOWLIST = new Set([
  "crux/validate/validate-no-sourcinged.ts",
  "crux/validate/validate-no-sourcinged.test.ts",
  "crux/validate/validate-gate.ts",
]);

interface Violation {
  file: string;
  line: number;
  text: string;
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
      if (SKIP_DIRS.has(entry)) continue;
      const fullPath = join(current, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (SCAN_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
        out.push(fullPath);
      }
    }
  }
  walk(dir);
  return out;
}

function checkFile(filePath: string): Violation[] {
  const content = readFileSync(filePath, "utf-8");
  if (!content.includes(BANNED)) return [];
  const relPath = relative(PROJECT_ROOT, filePath);
  if (ALLOWLIST.has(relPath)) return [];
  const violations: Violation[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(BANNED)) {
      violations.push({ file: relPath, line: i + 1, text: lines[i].trim() });
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
    `${c.blue}Checking for the banned non-word "${BANNED}"...${c.reset}\n`,
  );
  const allFiles: string[] = [];
  for (const dir of SCAN_DIRS) {
    allFiles.push(...collectFiles(join(PROJECT_ROOT, dir)));
  }
  const all: Violation[] = [];
  for (const file of allFiles) {
    all.push(...checkFile(file));
  }
  if (all.length === 0) {
    console.log(
      `${c.green}No "${BANNED}" occurrences found (${allFiles.length} files checked)${c.reset}`,
    );
  } else {
    console.log(
      `${c.red}Found ${all.length} occurrence(s) of "${BANNED}" — replace with "sourced":${c.reset}\n`,
    );
    for (const v of all) {
      console.log(`  ${c.red}${v.file}:${v.line}${c.reset}`);
      console.log(`    ${c.dim}${v.text}${c.reset}\n`);
    }
  }
  return { passed: all.length === 0, errors: all.length, violations: all };
}

if (process.argv[1]?.includes("validate-no-sourcinged")) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
