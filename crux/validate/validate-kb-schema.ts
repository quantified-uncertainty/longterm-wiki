#!/usr/bin/env node

/**
 * KB Schema Validation — gate check for knowledge base data integrity.
 *
 * Loads the KB graph from packages/kb/data/ and runs the full validation suite.
 * Exits non-zero if any error-severity issues are found.
 *
 * Usage:
 *   npx tsx crux/validate/validate-kb-schema.ts            # errors only (gate mode)
 *   npx tsx crux/validate/validate-kb-schema.ts --verbose   # include warnings
 */

import { join } from "path";
import type { ValidationResult } from "../../packages/kb/src/types.ts";
import { PROJECT_ROOT } from "../lib/content-types.ts";

const verbose = process.argv.includes("--verbose");

// Rules that are error-severity in validate.ts but treated as warnings for gate
// purposes. ref-integrity is demoted because many entities intentionally use
// plain-string values for organizations/people not yet modeled as KB entities
// (e.g., "University of Toronto", "Google Brain"). These are data quality items,
// not integrity violations.
const DEMOTED_RULES = new Set(["ref-integrity"]);

async function main(): Promise<void> {
  // Dynamic import to avoid loading KB code when this validator is skipped
  const { loadKB } = await import(
    join(PROJECT_ROOT, "packages/kb/src/loader.ts")
  );
  const { validate } = await import(
    join(PROJECT_ROOT, "packages/kb/src/validate.ts")
  );

  const dataDir = join(PROJECT_ROOT, "packages/kb/data");
  const graph = await loadKB(dataDir);
  const results: ValidationResult[] = validate(graph);

  // Separate blocking errors from demoted/warning-level issues
  const blockingErrors = results.filter(
    (r: { severity: string; rule: string }) => r.severity === "error" && !DEMOTED_RULES.has(r.rule)
  );
  const demotedErrors = results.filter(
    (r: { severity: string; rule: string }) => r.severity === "error" && DEMOTED_RULES.has(r.rule)
  );
  const warnings = results.filter((r: { severity: string }) => r.severity === "warning");

  if (verbose) {
    for (const w of warnings) {
      console.log(`⚠ [${w.rule}] ${w.message}`);
    }
    for (const d of demotedErrors) {
      console.log(`⚠ [${d.rule}] ${d.message} (demoted to warning)`);
    }
  }

  for (const e of blockingErrors) {
    console.error(`✗ [${e.rule}] ${e.message}`);
  }

  if (blockingErrors.length > 0) {
    console.error(
      `\nKB schema validation failed: ${blockingErrors.length} blocking error(s), ` +
        `${demotedErrors.length} demoted, ${warnings.length} warning(s)`
    );
    process.exit(1);
  }

  const entityCount = graph.getAllEntities().length;
  const demotedNote =
    demotedErrors.length > 0
      ? `, ${demotedErrors.length} ref-integrity warning(s)`
      : "";
  console.log(
    `KB schema validation passed: ${entityCount} entities, 0 blocking errors${demotedNote}, ${warnings.length} warning(s)`
  );
}

main().catch((err) => {
  console.error("KB schema validation crashed:", err);
  process.exit(1);
});
