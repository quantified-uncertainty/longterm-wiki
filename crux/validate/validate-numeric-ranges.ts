#!/usr/bin/env node

/**
 * Numeric Range Validator
 *
 * Validates that paired low/high range columns in PG tables have low <= high.
 * Checks: funding_rounds, investments, equity_positions.
 *
 * Network dependency: Requires wiki-server access. If unavailable, the check
 * is skipped gracefully (fail-open) since it cannot verify without PG data.
 *
 * Usage:
 *   npx tsx crux/validate/validate-numeric-ranges.ts
 *   npx tsx crux/validate/validate-numeric-ranges.ts --ci
 *
 * Exit codes:
 *   0 = No range violations found (or server unavailable — skipped)
 *   1 = Range violations found
 */

import { fileURLToPath } from "url";
import { getColors } from "../lib/output.ts";
import type { ValidatorResult, ValidatorOptions } from "./types.ts";
import type { Colors } from "../lib/output.ts";
import {
  getServerUrl,
  apiRequest,
} from "../lib/wiki-server/client.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A paired range field definition: the JSON keys for the low and high values,
 * plus a human-readable label (e.g., "raised", "valuation").
 */
export interface RangeFieldPair {
  lowField: string;
  highField: string;
  label: string;
}

/**
 * Configuration for a single table to check.
 */
export interface TableConfig {
  /** API endpoint path (e.g., "/api/funding-rounds/all") */
  endpoint: string;
  /** Human-readable table name */
  tableName: string;
  /** Key in the API response JSON that contains the array of records */
  recordsKey: string;
  /** Paired range fields to validate */
  rangePairs: RangeFieldPair[];
}

/**
 * A single range violation found during validation.
 */
export interface RangeViolation {
  table: string;
  recordId: string;
  fieldPair: string;
  low: number;
  high: number;
}

// ---------------------------------------------------------------------------
// Table configurations — defines which tables and fields to check
// ---------------------------------------------------------------------------

export const TABLE_CONFIGS: TableConfig[] = [
  {
    endpoint: "/api/funding-rounds/all",
    tableName: "funding_rounds",
    recordsKey: "fundingRounds",
    rangePairs: [
      { lowField: "raisedLow", highField: "raisedHigh", label: "raised" },
      { lowField: "valuationLow", highField: "valuationHigh", label: "valuation" },
    ],
  },
  {
    endpoint: "/api/investments/all",
    tableName: "investments",
    recordsKey: "investments",
    rangePairs: [
      { lowField: "amountLow", highField: "amountHigh", label: "amount" },
      { lowField: "stakeLow", highField: "stakeHigh", label: "stake" },
    ],
  },
  {
    endpoint: "/api/equity-positions/all",
    tableName: "equity_positions",
    recordsKey: "equityPositions",
    rangePairs: [
      { lowField: "stakeLow", highField: "stakeHigh", label: "stake" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Core validation logic (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Validate a single record against all range pairs for its table.
 * Returns violations where low > high (skips pairs where either value is null).
 */
export function validateRecord(
  record: Record<string, unknown>,
  tableName: string,
  rangePairs: RangeFieldPair[],
): RangeViolation[] {
  const violations: RangeViolation[] = [];
  const recordId = String(record.id ?? "unknown");

  for (const pair of rangePairs) {
    const low = record[pair.lowField];
    const high = record[pair.highField];

    // Skip if either value is null/undefined — nothing to compare
    if (low == null || high == null) continue;

    const lowNum = Number(low);
    const highNum = Number(high);

    // Skip if either is NaN (shouldn't happen with well-typed API data,
    // but guard against malformed responses)
    if (Number.isNaN(lowNum) || Number.isNaN(highNum)) continue;

    if (lowNum > highNum) {
      violations.push({
        table: tableName,
        recordId,
        fieldPair: `${pair.lowField}/${pair.highField}`,
        low: lowNum,
        high: highNum,
      });
    }
  }

  return violations;
}

/**
 * Fetch all records for a table config via the wiki-server API.
 * Paginates through results since the API has page size limits.
 */
export async function fetchAllRecords(
  config: TableConfig,
): Promise<{ ok: true; records: Record<string, unknown>[] } | { ok: false; message: string }> {
  const PAGE_SIZE = 200;
  const MAX_PAGES = 100;
  const allRecords: Record<string, unknown>[] = [];
  let offset = 0;
  let total = Infinity;
  let pageCount = 0;

  while (offset < total && pageCount < MAX_PAGES) {
    pageCount++;
    const result = await apiRequest<Record<string, unknown>>(
      "GET",
      `${config.endpoint}?limit=${PAGE_SIZE}&offset=${offset}`,
    );

    if (!result.ok) {
      return { ok: false, message: result.message };
    }

    const data = result.data;
    const records = data[config.recordsKey];

    if (!Array.isArray(records)) {
      return { ok: false, message: `Unexpected response shape: missing "${config.recordsKey}" array` };
    }

    allRecords.push(...(records as Record<string, unknown>[]));
    total = typeof data.total === "number" ? data.total : allRecords.length;
    offset += PAGE_SIZE;
  }

  return { ok: true, records: allRecords };
}

/**
 * Validate all tables and return all violations found.
 */
export async function validateAllTables(): Promise<
  | { ok: true; violations: RangeViolation[]; tableCounts: Record<string, number> }
  | { ok: false; message: string }
> {
  const allViolations: RangeViolation[] = [];
  const tableCounts: Record<string, number> = {};

  for (const config of TABLE_CONFIGS) {
    const fetchResult = await fetchAllRecords(config);

    if (!fetchResult.ok) {
      return { ok: false, message: `${config.tableName}: ${fetchResult.message}` };
    }

    tableCounts[config.tableName] = fetchResult.records.length;

    for (const record of fetchResult.records) {
      const violations = validateRecord(record, config.tableName, config.rangePairs);
      allViolations.push(...violations);
    }
  }

  return { ok: true, violations: allViolations, tableCounts };
}

// ---------------------------------------------------------------------------
// runCheck (for orchestrator / gate)
// ---------------------------------------------------------------------------

export async function runCheck(
  options: ValidatorOptions = {},
): Promise<ValidatorResult> {
  const ciMode = options.ci ?? false;
  const colors: Colors = getColors(ciMode);

  const serverUrl = getServerUrl();

  // Fail-open: if wiki-server is not configured, skip gracefully.
  // This check depends on network access to query PG records.
  if (!serverUrl) {
    if (!ciMode) {
      console.log(
        `${colors.dim}Numeric range check skipped — LONGTERMWIKI_SERVER_URL not set${colors.reset}`,
      );
    }
    return { passed: true, errors: 0, warnings: 1 };
  }

  if (!ciMode) {
    console.log(
      `${colors.blue}Checking numeric range fields (low <= high)...${colors.reset}\n`,
    );
  }

  const result = await validateAllTables();

  if (!result.ok) {
    // Fail-open: wiki-server is unreachable or errored.
    if (!ciMode) {
      console.log(
        `${colors.yellow}  Wiki-server unavailable (${result.message}) — skipping numeric range check${colors.reset}`,
      );
    }
    return { passed: true, errors: 0, warnings: 1 };
  }

  const { violations, tableCounts } = result;

  // Report table counts
  if (!ciMode) {
    for (const [table, count] of Object.entries(tableCounts)) {
      console.log(`  ${table}: ${count} records`);
    }
  }

  // Report results
  if (ciMode) {
    console.log(
      JSON.stringify(
        {
          tableCounts,
          violations,
          violationCount: violations.length,
        },
        null,
        2,
      ),
    );
  } else {
    if (violations.length === 0) {
      console.log(
        `\n${colors.green}  No range violations found${colors.reset}`,
      );
    } else {
      console.log(
        `\n${colors.yellow}  Found ${violations.length} range violation(s) (low > high):${colors.reset}\n`,
      );

      // Group by table for readability
      const byTable = new Map<string, RangeViolation[]>();
      for (const v of violations) {
        const list = byTable.get(v.table) ?? [];
        list.push(v);
        byTable.set(v.table, list);
      }

      for (const [table, tableViolations] of byTable) {
        console.log(`  ${colors.dim}${table}:${colors.reset}`);
        for (const v of tableViolations) {
          console.log(
            `    ${colors.yellow}${v.recordId}${colors.reset} — ${v.fieldPair}: low=${v.low}, high=${v.high}`,
          );
        }
      }
    }
  }

  const hasViolations = violations.length > 0;
  return {
    passed: !hasViolations,
    errors: hasViolations ? violations.length : 0,
    warnings: 0,
  };
}

// ---------------------------------------------------------------------------
// Standalone main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const result = await runCheck({
    ci: args.includes("--ci"),
  });
  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
