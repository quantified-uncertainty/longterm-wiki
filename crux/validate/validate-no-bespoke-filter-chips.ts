#!/usr/bin/env node

/**
 * Validate that no .tsx file under apps/web reintroduces the bespoke
 * filter-chip pattern that QUA-1009 swept away.
 *
 * The bug class (QUA-918): chip-style filter buttons that render
 *
 *   <button>
 *     {label}
 *     <span className="ml-1 text-[10px] opacity-60">{count}</span>
 *   </button>
 *
 * with no text-node separator. textContent comes out as "Label18" — wrong
 * for screen readers, copy-paste, and Playwright. The fix is to use
 * `<FilterChips>` / `<DirectoryFilterDropdown>` from @/components/directory,
 * which formats labels as "Label (count)" with a real space.
 *
 * This validator catches the precise CSS-class signature of the bespoke
 * pattern: `ml-1 text-[10px] opacity-60`. After the QUA-1009 sweep there
 * are zero matches in the codebase; any new occurrence is a regression.
 *
 * Suppression: append `// filter-chip-ok: <reason>` on the same line, used
 * by the canonical components themselves and the rare bespoke chip that
 * legitimately needs custom UX (e.g. /organizations chip with double-click
 * escalation — see organizations-view.tsx).
 *
 * Usage: npx tsx crux/validate/validate-no-bespoke-filter-chips.ts
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { PROJECT_ROOT } from "../lib/content-types.ts";
import { getColors } from "../lib/output.ts";

const SCAN_DIRS = ["apps/web/src"];

const BUG_PATTERN = /ml-1\s+text-\[10px\]\s+opacity-60/;

const SUPPRESSION = "filter-chip-ok";

interface Violation {
  file: string;
  line: number;
  text: string;
}

function collectTsxFiles(dir: string): string[] {
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
        if (entry === "node_modules" || entry === ".next" || entry === "__tests__") {
          continue;
        }
        walk(fullPath);
      } else if (entry.endsWith(".tsx") && !entry.endsWith(".test.tsx")) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

function scanFile(absPath: string): Violation[] {
  const content = readFileSync(absPath, "utf-8");
  const lines = content.split("\n");
  const violations: Violation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!BUG_PATTERN.test(line)) continue;
    if (line.includes(SUPPRESSION)) continue;
    violations.push({
      file: relative(PROJECT_ROOT, absPath),
      line: i + 1,
      text: line.trim(),
    });
  }

  return violations;
}

export function runCheck(): {
  passed: boolean;
  errors: string[];
  violations: Violation[];
} {
  const violations: Violation[] = [];
  for (const dir of SCAN_DIRS) {
    violations.push(...collectTsxFiles(join(PROJECT_ROOT, dir)).flatMap(scanFile));
  }

  if (violations.length === 0) {
    return { passed: true, errors: [], violations: [] };
  }

  const errors = violations.map(
    (v) =>
      `${v.file}:${v.line}: bespoke filter-chip pattern (use <FilterChips> from @/components/directory; if you genuinely need a custom chip, add // filter-chip-ok: <reason>)\n    ${v.text}`,
  );

  return { passed: false, errors, violations };
}

function main() {
  const colors = getColors(process.stdout.isTTY);
  const result = runCheck();

  if (result.passed) {
    console.log(
      `${colors.green}✓${colors.reset} validate-no-bespoke-filter-chips: 0 violations`,
    );
    process.exit(0);
  }

  console.error(
    `${colors.red}✗${colors.reset} validate-no-bespoke-filter-chips: ${result.violations.length} violation${result.violations.length === 1 ? "" : "s"}`,
  );
  for (const err of result.errors) {
    console.error(`  ${err}`);
  }
  console.error(
    "\nThe bespoke chip pattern produces concatenated text content like 'enacted18'.",
  );
  console.error(
    "Use <FilterChips> from @/components/directory for canonical chips.",
  );
  console.error(
    "Or add `// filter-chip-ok: <reason>` on the offending line if a custom chip is genuinely needed.",
  );
  process.exit(1);
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("validate-no-bespoke-filter-chips.ts")
) {
  main();
}
