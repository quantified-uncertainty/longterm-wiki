#!/usr/bin/env node

/**
 * YAML Entity Reference Validation — gate check
 *
 * Scans all entity YAML files and related data YAML files for fields that
 * reference entity slugs, and validates that each referenced entity actually
 * exists in the loaded entity set.
 *
 * This catches dangling references that would cause silent UI failures:
 *   - Raw IDs displayed instead of entity names
 *   - Broken links in relatedEntries sections
 *   - Missing affiliations in expert profiles
 *
 * Related bugs this would have caught:
 *   - #2723: affiliation: forethought (no forethought entity)
 *   - #2677: 19 person stableIds with no people.yaml entries
 *   - #2672: 4 policy entity slugs not in any YAML
 *
 * Usage:
 *   npx tsx crux/validate/validate-yaml-entity-refs.ts              # human-readable
 *   npx tsx crux/validate/validate-yaml-entity-refs.ts --ci         # JSON output
 *   npx tsx crux/validate/validate-yaml-entity-refs.ts --verbose    # show all dangling refs
 *
 * Exit codes:
 *   0 = All references resolve
 *   1 = Dangling references found (errors only; warnings don't fail)
 */

import { PROJECT_ROOT } from "../lib/content-types.ts";
import { getColors } from "../lib/output.ts";
import { validateYamlEntityRefs, type DanglingRef } from "./yaml-entity-ref-check.ts";

const ci = process.argv.includes("--ci");
const verbose = process.argv.includes("--verbose");
const c = getColors(ci);

function main(): void {
  const result = validateYamlEntityRefs(PROJECT_ROOT);

  const errors = result.danglingRefs.filter((r) => r.severity === "error");
  const warnings = result.danglingRefs.filter((r) => r.severity === "warning");

  if (ci) {
    console.log(
      JSON.stringify({
        passed: errors.length === 0,
        totalEntities: result.stats.totalEntities,
        totalRefsChecked: result.stats.totalRefsChecked,
        validRefs: result.stats.validRefs,
        errors: errors.length,
        warnings: warnings.length,
        danglingRefs: result.danglingRefs.map((r) => ({
          sourceFile: r.sourceFile,
          sourceId: r.sourceId,
          fieldName: r.fieldName,
          refValue: r.refValue,
          severity: r.severity,
          expectedType: r.expectedType,
        })),
      })
    );
  } else {
    console.log(
      `\n${c.bold}${c.blue}YAML Entity Reference Validation${c.reset}\n`
    );
    console.log(`Known entities: ${result.stats.totalEntities}`);
    console.log(`References checked: ${result.stats.totalRefsChecked}`);
    console.log(`Valid: ${result.stats.validRefs}`);
    console.log(
      `Dangling: ${errors.length} error(s), ${warnings.length} warning(s)\n`
    );

    // Show per-file breakdown
    const filesWithDangling = Object.entries(result.stats.byFile)
      .filter(([, s]) => s.dangling > 0)
      .sort(([, a], [, b]) => b.dangling - a.dangling);

    if (filesWithDangling.length > 0) {
      console.log(`${c.bold}Files with dangling references:${c.reset}`);
      for (const [file, stats] of filesWithDangling) {
        console.log(
          `  ${file}: ${stats.dangling}/${stats.checked} dangling`
        );
      }
      console.log("");
    }

    // Show errors
    if (errors.length > 0) {
      console.log(
        `${c.red}${c.bold}Dangling references (errors):${c.reset}`
      );
      const toShow = verbose ? errors : errors.slice(0, 30);
      for (const ref of toShow) {
        printRef(ref, c.red);
      }
      if (!verbose && errors.length > 30) {
        console.log(
          `  ... and ${errors.length - 30} more (use --verbose to see all)`
        );
      }
      console.log("");
    }

    // Show warnings
    if (warnings.length > 0 && verbose) {
      console.log(
        `${c.yellow}${c.bold}Unresolved references (warnings):${c.reset}`
      );
      const toShow = warnings.slice(0, 20);
      for (const ref of toShow) {
        printRef(ref, c.yellow);
      }
      if (warnings.length > 20) {
        console.log(
          `  ... and ${warnings.length - 20} more`
        );
      }
      console.log("");
    }

    // Summary
    if (errors.length === 0) {
      console.log(
        `${c.green}All ${result.stats.totalRefsChecked} YAML entity references resolve correctly.${c.reset}`
      );
      if (warnings.length > 0) {
        console.log(
          `${c.yellow}  (${warnings.length} warning(s) — informational only)${c.reset}`
        );
      }
    } else {
      console.log(
        `${c.red}${errors.length} dangling entity reference(s) found. ` +
          `These will cause broken links or missing data in the UI.${c.reset}`
      );
    }
  }

  if (errors.length > 0) {
    process.exit(1);
  }
}

function printRef(ref: DanglingRef, color: string): void {
  const typeHint = ref.expectedType ? ` (expected: ${ref.expectedType})` : "";
  console.log(
    `  ${color}x${getColors(false).reset} ${ref.sourceFile}: ${ref.sourceTitle} (${ref.sourceId}) ` +
      `— ${ref.fieldName} = "${ref.refValue}"${typeHint}`
  );
}

main();
