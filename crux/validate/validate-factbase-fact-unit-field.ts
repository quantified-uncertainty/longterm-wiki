#!/usr/bin/env node

/**
 * Reject `unit:` (and case/plural typos) at a FactBase fact top-level.
 * The loader only reads `currency:` for ISO 4217 overrides; `unit:` is
 * silently dropped and the property default takes over — which produced
 * QUA-620 ("$5 million" for a £5M fact).
 */

import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";
import { PROJECT_ROOT } from "../lib/content-types.ts";
import { getColors } from "../lib/output.ts";

const FB_ENTITIES_DIR = join(
  PROJECT_ROOT,
  "packages/factbase/data/fb-entities",
);

// Fact top-level = 4-space indent; a `unit:` inside a value block would be 6+.
// Case-insensitive + optional plural so typos (`Unit:`, `UNIT:`, `units:`) — which
// the loader also silently drops — surface here.
const FACT_TOP_LEVEL_UNIT_RE = /^ {4}(units?):\s*(\S.*?)\s*$/i;

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
