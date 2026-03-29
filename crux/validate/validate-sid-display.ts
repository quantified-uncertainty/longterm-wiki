#!/usr/bin/env node

/**
 * SID Display Name Validation — checks that no display name column in tablebase
 * records contains a sid_-prefixed value.
 *
 * Entity stableIds use the `sid_` prefix (e.g., `sid_1LcLlMGLbw`). Display name
 * columns should never contain these — they should contain human-readable names
 * or be NULL. This validator catches cases where the enrichment pipeline
 * incorrectly stores a stableId as a display name.
 *
 * Checks all 5 tables with display name columns:
 * - personnel: person_display_name, org_display_name
 * - grants: grantee_display_name, org_display_name
 * - funding_rounds: company_display_name, lead_investor_display_name
 * - investments: company_display_name, investor_display_name
 * - equity_positions: company_display_name, holder_display_name
 *
 * Also checks that raw ID fields (person_id, grantee_id, etc.) that contain
 * sid_-prefixed values have a resolved entity FK.
 *
 * Requires wiki-server to be running (queries the API). Advisory — not CI-blocking.
 *
 * Usage:
 *   npx tsx crux/validate/validate-sid-display.ts              # advisory mode
 *   npx tsx crux/validate/validate-sid-display.ts --verbose     # show all issues
 *   npx tsx crux/validate/validate-sid-display.ts --ci          # JSON output
 */

import { getColors } from "../lib/output.ts";
import { fetchAllRecords } from "./validate-soft-fks.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Check whether a string is a sid_-prefixed stableId. */
export function isSid(value: string): boolean {
  return value.startsWith("sid_");
}

/** A display name column that contains a sid_ value — always an error. */
export interface SidDisplayError {
  table: string;
  recordId: string;
  field: string;
  value: string;
}

/** A raw ID column with a sid_ value and no resolved entity FK — a warning. */
export interface SidIdWarning {
  table: string;
  recordId: string;
  idField: string;
  idValue: string;
  entityFkField: string;
}

/** Per-table results. */
export interface TableResult {
  table: string;
  totalRecords: number;
  displayErrors: SidDisplayError[];
  idWarnings: SidIdWarning[];
}

/** Full validation result. */
export interface SidDisplayResult {
  passed: boolean;
  tables: TableResult[];
  totalErrors: number;
  totalWarnings: number;
}

// ---------------------------------------------------------------------------
// Table specifications — which fields to check
// ---------------------------------------------------------------------------

interface DisplayFieldSpec {
  /** camelCase field name for the display name column. */
  displayField: string;
}

interface IdFieldSpec {
  /** camelCase field name for the raw ID column. */
  idField: string;
  /** camelCase field name for the resolved entity FK column. */
  entityFkField: string;
}

interface TableDisplaySpec {
  apiPath: string;
  responseKey: string;
  displayFields: DisplayFieldSpec[];
  idFields: IdFieldSpec[];
  maxLimit?: number;
}

export const TABLE_DISPLAY_SPECS: TableDisplaySpec[] = [
  {
    apiPath: "/api/personnel/all",
    responseKey: "personnel",
    displayFields: [
      { displayField: "personDisplayName" },
      { displayField: "orgDisplayName" },
    ],
    idFields: [
      { idField: "personId", entityFkField: "personEntityId" },
      { idField: "organizationId", entityFkField: "orgEntityId" },
    ],
    maxLimit: 200,
  },
  {
    apiPath: "/api/grants/all",
    responseKey: "grants",
    displayFields: [
      { displayField: "granteeDisplayName" },
      { displayField: "orgDisplayName" },
    ],
    idFields: [
      { idField: "granteeId", entityFkField: "granteeEntityId" },
      { idField: "organizationId", entityFkField: "orgEntityId" },
    ],
    maxLimit: 200,
  },
  {
    apiPath: "/api/funding-rounds/all",
    responseKey: "fundingRounds",
    displayFields: [
      { displayField: "companyDisplayName" },
      { displayField: "leadInvestorDisplayName" },
    ],
    idFields: [
      { idField: "companyId", entityFkField: "companyEntityId" },
      { idField: "leadInvestor", entityFkField: "leadInvestorEntityId" },
    ],
    maxLimit: 200,
  },
  {
    apiPath: "/api/investments/all",
    responseKey: "investments",
    displayFields: [
      { displayField: "companyDisplayName" },
      { displayField: "investorDisplayName" },
    ],
    idFields: [
      { idField: "companyId", entityFkField: "companyEntityId" },
      { idField: "investorId", entityFkField: "investorEntityId" },
    ],
    maxLimit: 200,
  },
  {
    apiPath: "/api/equity-positions/all",
    responseKey: "equityPositions",
    displayFields: [
      { displayField: "companyDisplayName" },
      { displayField: "holderDisplayName" },
    ],
    idFields: [
      { idField: "companyId", entityFkField: "companyEntityId" },
      { idField: "holderId", entityFkField: "holderEntityId" },
    ],
    maxLimit: 200,
  },
];

// ---------------------------------------------------------------------------
// Validation logic
// ---------------------------------------------------------------------------

/**
 * Validate a single table for sid_ display names and unresolved sid_ IDs.
 */
export async function validateTableDisplay(
  spec: TableDisplaySpec,
): Promise<TableResult> {
  const result: TableResult = {
    table: spec.responseKey,
    totalRecords: 0,
    displayErrors: [],
    idWarnings: [],
  };

  const records = await fetchAllRecords(
    spec.apiPath,
    spec.responseKey,
    spec.maxLimit,
  );

  if (!records) {
    return result;
  }

  result.totalRecords = records.length;

  for (const record of records) {
    const recordId = String(record.id ?? "unknown");

    // Check display name columns for sid_ values — always an error
    for (const { displayField } of spec.displayFields) {
      const value = record[displayField];
      if (typeof value === "string" && isSid(value)) {
        result.displayErrors.push({
          table: spec.responseKey,
          recordId,
          field: displayField,
          value,
        });
      }
    }

    // Check raw ID columns — if sid_ and entity FK is NULL, it's a warning
    for (const { idField, entityFkField } of spec.idFields) {
      const idValue = record[idField];
      if (typeof idValue === "string" && isSid(idValue)) {
        const fkValue = record[entityFkField];
        if (fkValue === null || fkValue === undefined || fkValue === "") {
          result.idWarnings.push({
            table: spec.responseKey,
            recordId,
            idField,
            idValue,
            entityFkField,
          });
        }
      }
    }
  }

  return result;
}

/**
 * Validate all tables from the provided specs.
 * Exported for testing — accepts specs so mocks can supply custom specs.
 */
export async function validateAllTables(
  specs: TableDisplaySpec[],
): Promise<TableResult[]> {
  const results: TableResult[] = [];
  for (const spec of specs) {
    results.push(await validateTableDisplay(spec));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runValidation(opts: {
  verbose?: boolean;
  ci?: boolean;
}): Promise<SidDisplayResult> {
  const { verbose = false, ci = false } = opts;
  const c = getColors(ci);

  if (!ci) {
    console.log(
      `\n${c.bold}${c.blue}SID Display Name Validation — Checking for sid_ values in display columns${c.reset}\n`,
    );
  }

  const allResults: TableResult[] = [];

  for (const spec of TABLE_DISPLAY_SPECS) {
    if (!ci) {
      process.stdout.write(
        `${c.dim}  Checking ${spec.responseKey}...${c.reset}`,
      );
    }

    const result = await validateTableDisplay(spec);
    allResults.push(result);

    if (!ci) {
      if (result.totalRecords === 0) {
        console.log(` ${c.dim}(empty or unreachable)${c.reset}`);
      } else if (
        result.displayErrors.length === 0 &&
        result.idWarnings.length === 0
      ) {
        console.log(
          ` ${c.green}${result.totalRecords} records clean${c.reset}`,
        );
      } else {
        const parts: string[] = [];
        if (result.displayErrors.length > 0) {
          parts.push(
            `${c.red}${result.displayErrors.length} display error(s)${c.reset}`,
          );
        }
        if (result.idWarnings.length > 0) {
          parts.push(
            `${c.yellow}${result.idWarnings.length} ID warning(s)${c.reset}`,
          );
        }
        console.log(` ${parts.join(", ")}`);
      }
    }
  }

  // Aggregate
  let totalErrors = 0;
  let totalWarnings = 0;
  for (const r of allResults) {
    totalErrors += r.displayErrors.length;
    totalWarnings += r.idWarnings.length;
  }

  const passed = totalErrors === 0;

  // Print summary table
  if (!ci) {
    console.log(`\n${"─".repeat(70)}`);
    console.log(
      "| Table                  | Records | Display Errors | ID Warnings |",
    );
    console.log(
      "|------------------------|---------|----------------|-------------|",
    );

    for (const r of allResults) {
      const table = r.table.padEnd(22);
      const rec = r.totalRecords.toString().padStart(7);
      const errs = r.displayErrors.length.toString().padStart(14);
      const warns = r.idWarnings.length.toString().padStart(11);
      console.log(`| ${table} | ${rec} | ${errs} | ${warns} |`);
    }

    console.log(
      "|------------------------|---------|----------------|-------------|",
    );
    const totalTable = "TOTAL".padEnd(22);
    const totalRec = allResults
      .reduce((s, t) => s + t.totalRecords, 0)
      .toString()
      .padStart(7);
    const totalErrsStr = totalErrors.toString().padStart(14);
    const totalWarnsStr = totalWarnings.toString().padStart(11);
    console.log(
      `| ${totalTable} | ${totalRec} | ${totalErrsStr} | ${totalWarnsStr} |`,
    );
    console.log("─".repeat(70));

    // Print details
    const allErrors = allResults.flatMap((r) => r.displayErrors);
    const allWarnings = allResults.flatMap((r) => r.idWarnings);

    if (allErrors.length > 0) {
      console.log(
        `\n${c.red}Display name columns containing sid_ values (ERROR):${c.reset}`,
      );
      const toShow = verbose ? allErrors : allErrors.slice(0, 10);
      for (const err of toShow) {
        console.log(
          `  ${c.red}x${c.reset} ${err.table}.${err.field} = "${err.value}" (record ${err.recordId})`,
        );
      }
      if (!verbose && allErrors.length > 10) {
        console.log(
          `  ${c.dim}... and ${allErrors.length - 10} more (use --verbose)${c.reset}`,
        );
      }
    }

    if (allWarnings.length > 0) {
      console.log(
        `\n${c.yellow}Raw ID columns with sid_ values and no resolved entity FK (WARNING):${c.reset}`,
      );
      const toShow = verbose ? allWarnings : allWarnings.slice(0, 10);
      for (const warn of toShow) {
        console.log(
          `  ${c.yellow}~${c.reset} ${warn.table}.${warn.idField} = "${warn.idValue}" (record ${warn.recordId}, ${warn.entityFkField} = NULL)`,
        );
      }
      if (!verbose && allWarnings.length > 10) {
        console.log(
          `  ${c.dim}... and ${allWarnings.length - 10} more (use --verbose)${c.reset}`,
        );
      }
    }

    // Summary
    console.log("");
    if (passed && totalWarnings === 0) {
      console.log(
        `${c.green}No sid_ values found in display name columns. All clean.${c.reset}`,
      );
    } else if (passed) {
      console.log(
        `${c.green}No sid_ values in display name columns.${c.reset} ${c.yellow}${totalWarnings} unresolved sid_ ID warning(s).${c.reset}`,
      );
    } else {
      console.log(
        `${c.red}${totalErrors} display name column(s) contain sid_ values.${c.reset}`,
      );
      if (totalWarnings > 0) {
        console.log(
          `${c.yellow}${totalWarnings} unresolved sid_ ID warning(s).${c.reset}`,
        );
      }
    }
  }

  // CI JSON output
  if (ci) {
    console.log(
      JSON.stringify({
        passed,
        totalErrors,
        totalWarnings,
        byTable: Object.fromEntries(
          allResults.map((r) => [
            r.table,
            {
              records: r.totalRecords,
              displayErrors: r.displayErrors.length,
              idWarnings: r.idWarnings.length,
            },
          ]),
        ),
        errors: allResults.flatMap((r) =>
          r.displayErrors.map((e) => ({
            table: e.table,
            recordId: e.recordId,
            field: e.field,
            value: e.value,
          })),
        ),
        warnings: allResults.flatMap((r) =>
          r.idWarnings.map((w) => ({
            table: w.table,
            recordId: w.recordId,
            idField: w.idField,
            idValue: w.idValue,
            entityFkField: w.entityFkField,
          })),
        ),
      }),
    );
  }

  return {
    passed,
    tables: allResults,
    totalErrors,
    totalWarnings,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const verbose = process.argv.includes("--verbose");
  const ci = process.argv.includes("--ci");

  const result = await runValidation({ verbose, ci });

  if (!result.passed) {
    process.exit(1);
  }
}

if (process.argv[1]?.includes("validate-sid-display")) {
  main().catch((err) => {
    console.error("SID display name validation crashed:", err);
    process.exit(1);
  });
}
