#!/usr/bin/env node

/**
 * Validate that URL-normalization functions live only in @longterm-wiki/url-utils.
 *
 * QUA-341 consolidated 7 different `normalizeUrl`-style helpers (each with subtly
 * different semantics) into a single canonical helper in the url-utils package.
 * This validator prevents regression — it scans crux/, apps/web/src/, and
 * apps/web/scripts/ for new local definitions of `normalizeUrl`,
 * `normalizeUrlForJoin`, `normalizeUrlForDedup`, `normalizeUrlKey`, or
 * `urlMatches` outside the canonical package and an explicit allowlist of
 * thin wrappers/re-exports.
 *
 * Usage: npx tsx crux/validate/validate-url-normalize.ts
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { PROJECT_ROOT } from "../lib/content-types.ts";
import { getColors } from "../lib/output.ts";

/** Directories to scan (relative to PROJECT_ROOT) */
const SCAN_DIRS = [
  "crux",
  "apps/web/src",
  "apps/web/scripts",
  "apps/wiki-server/src",
  "apps/groundskeeper/src",
];

/** Files allowed to define their own URL normalizer (canonical + thin wrappers). */
const ALLOWLIST = new Set<string>([
  // Canonical helper itself.
  "packages/url-utils/src/index.ts",
  // Two remaining thin wrappers that change call signature (return string vs
  // boolean), not just option presets. If you remove either, drop the entry.
  "crux/lib/search/resource-lookup.ts", // normalizeUrlKey — bounds the cache key
  "crux/lib/sourcing/fuzzy-match.ts", // urlMatches — boolean comparator
  "crux/resource-utils.ts", // resourceUrlKey — typed for Resource maps
]);

/** Function names that this validator considers URL-normalizers. */
const BANNED_NAMES = [
  "normalizeUrl",
  "normalizeUrlForJoin",
  "normalizeUrlForDedup",
  "normalizeUrlForLookup",
  "normalizeUrlForMatch",
  "normalizeUrlKey",
  "urlMatches",
];

/** Match `function NAME(`, `const NAME = ...`, `let NAME = ...`, `var NAME = ...`. */
const FUNCTION_DEF_PATTERN = new RegExp(
  `\\b(?:function|const|let|var)\\s+(${BANNED_NAMES.join("|")})\\b`,
);

interface Violation {
  file: string;
  line: number;
  text: string;
  symbol: string;
}

function collectFiles(dir: string): string[] {
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
        if (
          entry === "node_modules" ||
          entry === ".next" ||
          entry === "dist" ||
          entry === "coverage" ||
          entry === "__tests__"
        ) {
          continue;
        }
        walk(fullPath);
      } else if (
        (entry.endsWith(".ts") || entry.endsWith(".tsx") || entry.endsWith(".mjs")) &&
        !entry.endsWith(".test.ts") &&
        !entry.endsWith(".test.tsx") &&
        !entry.endsWith(".test.mjs") &&
        !entry.endsWith(".d.ts")
      ) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

function checkFile(filePath: string): Violation[] {
  const relPath = relative(PROJECT_ROOT, filePath);
  if (ALLOWLIST.has(relPath)) return [];

  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const violations: Violation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Skip commented-out lines and JSDoc.
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*")
    ) {
      continue;
    }

    const match = trimmed.match(FUNCTION_DEF_PATTERN);
    if (match) {
      violations.push({
        file: relPath,
        line: i + 1,
        text: trimmed,
        symbol: match[1],
      });
    }
  }

  return violations;
}

export function runCheck(): { passed: boolean; errors: number; violations: Violation[] } {
  const c = getColors();
  console.log(
    `${c.blue}Checking for stray URL-normalization helpers (QUA-341)...${c.reset}\n`,
  );

  const allFiles: string[] = [];
  for (const dir of SCAN_DIRS) {
    const absDir = join(PROJECT_ROOT, dir);
    const files = collectFiles(absDir);
    allFiles.push(...files);
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
      `${c.green}No stray URL normalizers found (${allFiles.length} files checked)${c.reset}`,
    );
  } else {
    console.log(
      `${c.red}Found ${allViolations.length} stray URL normalizer definition(s):${c.reset}\n`,
    );
    for (const v of allViolations) {
      console.log(`  ${c.red}${v.file}:${v.line}${c.reset} — defines ${v.symbol}`);
      console.log(`    ${c.dim}${v.text}${c.reset}`);
    }
    console.log();
    console.log(
      `  ${c.dim}Fix: import { normalizeUrl } from "@longterm-wiki/url-utils" and pass options as needed.${c.reset}`,
    );
    console.log(
      `  ${c.dim}     If a thin wrapper is genuinely needed, add the file path to the ALLOWLIST in this validator.${c.reset}`,
    );
  }

  return {
    passed: allViolations.length === 0,
    errors: allViolations.length,
    violations: allViolations,
  };
}

if (process.argv[1]?.includes("validate-url-normalize")) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
