#!/usr/bin/env node

/**
 * Validate that FactBase fact entries don't use a top-level `unit:` field.
 *
 * The Fact schema (packages/factbase/src/types.ts) declares `currency` for
 * ISO 4217 overrides. The loader (packages/factbase/src/loader.ts::parseFact)
 * only reads `currency` — a top-level `unit:` on a fact is silently dropped,
 * and the property-level unit default applies. This looks like the author
 * set a currency, but the rendered value uses the property's default symbol
 * (usually $), producing wrong output like "$5 million" for a £5M fact.
 *
 * Incident: QUA-620. Ada Lovelace Institute's total-funding fact had
 * `unit: GBP`; the overview rendered "$5 million" while the /data page's
 * funding round (correctly stored) rendered "£5M / $6.7M".
 *
 * Fix: use `currency: GBP` (or `currency: EUR` etc.) at the fact top-level.
 *
 * Usage: npx tsx crux/validate/validate-factbase-fact-unit-field.ts
 */

import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";
import { PROJECT_ROOT } from "../lib/content-types.ts";
import { getColors } from "../lib/output.ts";

const FB_ENTITIES_DIR = join(
  PROJECT_ROOT,
  "packages/factbase/data/fb-entities",
);

// Fact top-level fields live at YAML indent depth 4 (2-space indent):
//   facts:
//     - id: f_x
//       property: p
//       unit: GBP      <- depth 4 (4 spaces)
//       value: ...
// A `unit:` inside a structured value block would be deeper (6+ spaces).
//
// Case-insensitive on the key name so typos like `Unit:`, `UNIT:`, and
// plural `units:` also surface — the loader drops all of them silently.
const FACT_TOP_LEVEL_UNIT_RE = /^ {4}(unit|Unit|UNIT|units):\s*(\S.*?)\s*$/;

export interface Violation {
  file: string;
  line: number;
  text: string;
  suggestion: string;
}

/**
 * Scan YAML content for `unit:` at fact top-level (indent depth 4).
 * Exported for direct testing.
 */
export function checkContent(
  content: string,
  filePath = "<inline>",
): Violation[] {
  const lines = content.split("\n");
  const violations: Violation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = FACT_TOP_LEVEL_UNIT_RE.exec(line);
    if (!match) continue;
    const key = match[1];
    const rawValue = match[2];
    violations.push({
      file: filePath,
      line: i + 1,
      text: line,
      suggestion: `Replace \`${key}: ${rawValue}\` with \`currency: ${rawValue}\` (or remove if redundant with property default).`,
    });
  }

  return violations;
}

function checkFile(filePath: string): Violation[] {
  const content = readFileSync(filePath, "utf-8");
  const relPath = relative(PROJECT_ROOT, filePath);
  return checkContent(content, relPath);
}

export function runCheck(): {
  passed: boolean;
  errors: number;
  violations: Violation[];
} {
  const c = getColors();
  console.log(
    `${c.blue}Checking for dropped \`unit:\` fields at FactBase fact top-level...${c.reset}\n`,
  );

  let files: string[];
  try {
    files = readdirSync(FB_ENTITIES_DIR)
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => join(FB_ENTITIES_DIR, f));
  } catch {
    console.log(`${c.dim}fb-entities directory not found: ${FB_ENTITIES_DIR}${c.reset}`);
    return { passed: true, errors: 0, violations: [] };
  }

  const allViolations: Violation[] = [];
  for (const file of files) {
    allViolations.push(...checkFile(file));
  }

  if (allViolations.length === 0) {
    console.log(
      `${c.green}No stray \`unit:\` fields found (${files.length} files checked)${c.reset}`,
    );
  } else {
    console.log(
      `${c.red}Found ${allViolations.length} stray \`unit:\` field(s) that the loader will silently drop:${c.reset}\n`,
    );
    for (const v of allViolations) {
      console.log(`  ${c.red}${v.file}:${v.line}${c.reset}`);
      console.log(`    ${c.dim}${v.text}${c.reset}`);
      console.log(`    ${c.dim}Fix: ${v.suggestion}${c.reset}\n`);
    }
    console.log(
      `${c.dim}Background: facts use \`currency\` for ISO 4217 overrides; \`unit\` is only valid on Property definitions in properties.yaml. See QUA-620.${c.reset}`,
    );
  }

  return {
    passed: allViolations.length === 0,
    errors: allViolations.length,
    violations: allViolations,
  };
}

if (process.argv[1]?.includes("validate-factbase-fact-unit-field")) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
