#!/usr/bin/env node

/**
 * KB Schema Validation — gate check for knowledge base data integrity.
 *
 * Loads the KB graph from packages/kb/data/ and runs the full validation suite.
 * Exits non-zero if any error-severity issues are found.
 *
 * Usage:
 *   npx tsx crux/validate/validate-kb-schema.ts            # errors only (gate mode)
 *   npx tsx crux/validate/validate-kb-schema.ts --verbose   # include warnings + info
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

/** Print a summary table of validation results grouped by rule and severity. */
function printSummaryTable(results: ValidationResult[]): void {
  // Count by rule × severity
  const counts = new Map<string, { error: number; warning: number; info: number }>();

  for (const r of results) {
    if (!counts.has(r.rule)) {
      counts.set(r.rule, { error: 0, warning: 0, info: 0 });
    }
    const entry = counts.get(r.rule)!;
    if (r.severity === "error") entry.error++;
    else if (r.severity === "warning") entry.warning++;
    else entry.info++;
  }

  // Sort by total count descending
  const sorted = [...counts.entries()].sort((a, b) => {
    const totalA = a[1].error + a[1].warning + a[1].info;
    const totalB = b[1].error + b[1].warning + b[1].info;
    return totalB - totalA;
  });

  console.log("\n┌─────────────────────────────────┬───────┬─────────┬──────┬───────┐");
  console.log("│ Rule                            │ Error │ Warning │ Info │ Total │");
  console.log("├─────────────────────────────────┼───────┼─────────┼──────┼───────┤");

  let totalErrors = 0;
  let totalWarnings = 0;
  let totalInfo = 0;

  for (const [rule, c] of sorted) {
    const total = c.error + c.warning + c.info;
    totalErrors += c.error;
    totalWarnings += c.warning;
    totalInfo += c.info;

    const ruleCol = rule.padEnd(31);
    const errCol = (c.error || "").toString().padStart(5);
    const warnCol = (c.warning || "").toString().padStart(7);
    const infoCol = (c.info || "").toString().padStart(4);
    const totalCol = total.toString().padStart(5);
    console.log(`│ ${ruleCol} │ ${errCol} │ ${warnCol} │ ${infoCol} │ ${totalCol} │`);
  }

  const grandTotal = totalErrors + totalWarnings + totalInfo;
  console.log("├─────────────────────────────────┼───────┼─────────┼──────┼───────┤");
  console.log(
    `│ ${"TOTAL".padEnd(31)} │ ${totalErrors.toString().padStart(5)} │ ${totalWarnings.toString().padStart(7)} │ ${totalInfo.toString().padStart(4)} │ ${grandTotal.toString().padStart(5)} │`
  );
  console.log("└─────────────────────────────────┴───────┴─────────┴──────┴───────┘");
}

async function main(): Promise<void> {
  // Dynamic import to avoid loading KB code when this validator is skipped
  const { loadKB } = await import(
    join(PROJECT_ROOT, "packages/kb/src/loader.ts")
  );
  const { validate } = await import(
    join(PROJECT_ROOT, "packages/kb/src/validate.ts")
  );

  const dataDir = join(PROJECT_ROOT, "packages/kb/data");
  const { graph } = await loadKB(dataDir);
  const results: ValidationResult[] = validate(graph);

  // Separate blocking errors from demoted/warning-level issues
  const blockingErrors = results.filter(
    (r: { severity: string; rule: string }) => r.severity === "error" && !DEMOTED_RULES.has(r.rule)
  );
  const demotedErrors = results.filter(
    (r: { severity: string; rule: string }) => r.severity === "error" && DEMOTED_RULES.has(r.rule)
  );
  const warnings = results.filter((r: { severity: string }) => r.severity === "warning");
  const infos = results.filter((r: { severity: string }) => r.severity === "info");

  if (verbose) {
    for (const w of warnings) {
      console.log(`\u26A0 [${w.rule}] ${w.message}`);
    }
    for (const d of demotedErrors) {
      console.log(`\u26A0 [${d.rule}] ${d.message} (demoted to warning)`);
    }
  }

  for (const e of blockingErrors) {
    console.error(`\u2717 [${e.rule}] ${e.message}`);
  }

  // Always print the summary table for visibility
  printSummaryTable(results);

  if (blockingErrors.length > 0) {
    console.error(
      `\nKB schema validation failed: ${blockingErrors.length} blocking error(s), ` +
        `${demotedErrors.length} demoted, ${warnings.length} warning(s), ${infos.length} info`
    );
    process.exit(1);
  }

  const entityCount = graph.getAllEntities().length;
  const demotedNote =
    demotedErrors.length > 0
      ? `, ${demotedErrors.length} ref-integrity warning(s)`
      : "";
  console.log(
    `\nKB schema validation passed: ${entityCount} entities, 0 blocking errors${demotedNote}, ${warnings.length} warning(s), ${infos.length} info`
  );
}

main().catch((err) => {
  console.error("KB schema validation crashed:", err);
  process.exit(1);
});
