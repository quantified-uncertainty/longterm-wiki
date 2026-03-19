#!/usr/bin/env node

/**
 * PG Temporal Consistency Validator
 *
 * Validates temporal consistency of date fields in PG tables:
 *   - startDate < endDate when both exist (start/end pairs)
 *   - All dates are in a reasonable range (1900–2100)
 *   - Date format is valid (YYYY, YYYY-MM, or ISO date)
 *
 * Tables checked:
 *   - personnel: startDate, endDate
 *   - divisions: startDate, endDate
 *   - division_personnel: startDate, endDate
 *   - equity_positions: asOf, validEnd
 *   - funding_programs: openDate, deadline
 *   - funding_rounds: date (single)
 *   - investments: date (single)
 *   - grants: date (single)
 *   - benchmarks: introducedDate (single)
 *   - benchmark_results: date (single)
 *
 * Network dependency: Requires wiki-server access. If unavailable, the check
 * is skipped gracefully (fail-open).
 *
 * Usage:
 *   npx tsx crux/validate/validate-pg-temporal.ts
 *   npx tsx crux/validate/validate-pg-temporal.ts --ci
 *
 * Exit codes:
 *   0 = No issues found (or server unavailable — skipped)
 *   1 = Issues found
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

/** A single temporal violation found in a PG record. */
export interface TemporalViolation {
  table: string;
  recordId: string;
  field: string;
  value: string;
  issue: string;
  severity: "error" | "warning";
}

/** Configuration for a table with a start/end date pair. */
export interface DatePairTableConfig {
  kind: "pair";
  table: string;
  apiPath: string;
  /** JSON key for the array of records in the API response. */
  recordsKey: string;
  startField: string;
  endField: string;
}

/** Configuration for a table with a single date field. */
export interface SingleDateTableConfig {
  kind: "single";
  table: string;
  apiPath: string;
  /** JSON key for the array of records in the API response. */
  recordsKey: string;
  dateField: string;
}

export type TableConfig = DatePairTableConfig | SingleDateTableConfig;

// ---------------------------------------------------------------------------
// Date validation helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Matches YYYY, YYYY-MM, YYYY-MM-DD, or full ISO date strings. */
const DATE_PATTERN = /^\d{4}(?:-\d{2}(?:-\d{2}(?:T[\d:.Z+-]+)?)?)?$/;

/** Minimum reasonable year for the knowledge base. */
const MIN_YEAR = 1900;
/** Maximum reasonable year (far enough in the future for deadlines). */
const MAX_YEAR = 2100;

/**
 * Parse a flexible date string into a comparable numeric value.
 * Returns null if the date string is invalid.
 *
 * Supports: YYYY, YYYY-MM, YYYY-MM-DD, ISO datetime.
 * Returns a numeric representation for ordering (YYYYMMDD).
 */
export function parseDateToNumeric(dateStr: string): number | null {
  if (!DATE_PATTERN.test(dateStr)) return null;

  const parts = dateStr.split(/[-T]/);
  const year = parseInt(parts[0], 10);
  const month = parts.length > 1 ? parseInt(parts[1], 10) : 1;
  const day = parts.length > 2 ? parseInt(parts[2], 10) : 1;

  if (isNaN(year) || isNaN(month) || isNaN(day)) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;

  return year * 10000 + month * 100 + day;
}

/**
 * Extract the year from a flexible date string. Returns null if invalid.
 */
export function extractYear(dateStr: string): number | null {
  const match = dateStr.match(/^(\d{4})/);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  return isNaN(year) ? null : year;
}

/**
 * Validate a single date string for format and range.
 * Returns violations found, if any.
 */
export function validateDateField(
  table: string,
  recordId: string,
  field: string,
  value: string,
): TemporalViolation[] {
  const violations: TemporalViolation[] = [];

  // Check format
  if (!DATE_PATTERN.test(value)) {
    violations.push({
      table,
      recordId,
      field,
      value,
      issue: `Invalid date format (expected YYYY, YYYY-MM, or YYYY-MM-DD)`,
      severity: "warning",
    });
    return violations; // Skip range check if format is bad
  }

  // Check range
  const year = extractYear(value);
  if (year !== null && (year < MIN_YEAR || year > MAX_YEAR)) {
    violations.push({
      table,
      recordId,
      field,
      value,
      issue: `Date year ${year} is outside reasonable range (${MIN_YEAR}–${MAX_YEAR})`,
      severity: "warning",
    });
  }

  return violations;
}

/**
 * Validate a start/end date pair for temporal consistency.
 * Returns violations found, if any.
 */
export function validateDatePair(
  table: string,
  recordId: string,
  startField: string,
  startValue: string | null | undefined,
  endField: string,
  endValue: string | null | undefined,
): TemporalViolation[] {
  const violations: TemporalViolation[] = [];

  // Validate individual fields
  if (startValue) {
    violations.push(...validateDateField(table, recordId, startField, startValue));
  }
  if (endValue) {
    violations.push(...validateDateField(table, recordId, endField, endValue));
  }

  // Check ordering: start < end
  if (startValue && endValue) {
    const startNum = parseDateToNumeric(startValue);
    const endNum = parseDateToNumeric(endValue);

    if (startNum !== null && endNum !== null && startNum > endNum) {
      violations.push({
        table,
        recordId,
        field: `${startField} / ${endField}`,
        value: `${startValue} → ${endValue}`,
        issue: `Start date (${startValue}) is after end date (${endValue})`,
        severity: "error",
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Table configurations
// ---------------------------------------------------------------------------

export const TABLE_CONFIGS: TableConfig[] = [
  // Tables with start/end date pairs
  {
    kind: "pair",
    table: "personnel",
    apiPath: "/api/personnel/all",
    recordsKey: "personnel",
    startField: "startDate",
    endField: "endDate",
  },
  {
    kind: "pair",
    table: "divisions",
    apiPath: "/api/divisions/all",
    recordsKey: "divisions",
    startField: "startDate",
    endField: "endDate",
  },
  {
    kind: "pair",
    table: "division_personnel",
    apiPath: "/api/division-personnel/all",
    recordsKey: "divisionPersonnel",
    startField: "startDate",
    endField: "endDate",
  },
  {
    kind: "pair",
    table: "equity_positions",
    apiPath: "/api/equity-positions/all",
    recordsKey: "equityPositions",
    startField: "asOf",
    endField: "validEnd",
  },
  {
    kind: "pair",
    table: "funding_programs",
    apiPath: "/api/funding-programs/all",
    recordsKey: "fundingPrograms",
    startField: "openDate",
    endField: "deadline",
  },
  // Tables with single date fields
  {
    kind: "single",
    table: "funding_rounds",
    apiPath: "/api/funding-rounds/all",
    recordsKey: "fundingRounds",
    dateField: "date",
  },
  {
    kind: "single",
    table: "investments",
    apiPath: "/api/investments/all",
    recordsKey: "investments",
    dateField: "date",
  },
  {
    kind: "single",
    table: "grants",
    apiPath: "/api/grants/all",
    recordsKey: "grants",
    dateField: "date",
  },
  {
    kind: "single",
    table: "benchmarks",
    apiPath: "/api/benchmarks/all",
    recordsKey: "benchmarks",
    dateField: "introducedDate",
  },
  {
    kind: "single",
    table: "benchmark_results",
    apiPath: "/api/benchmark-results/all",
    recordsKey: "results",
    dateField: "date",
  },
];

// ---------------------------------------------------------------------------
// Fetch and validate logic
// ---------------------------------------------------------------------------

/** Pagination parameters that all /all endpoints accept. */
const MAX_PAGE_SIZE = 200;
const MAX_PAGES = 100; // safety cap: 20,000 records per table

/**
 * Fetch all records from a paginated /all endpoint.
 * Returns null if the API is unreachable.
 */
async function fetchAllRecords(
  config: TableConfig,
): Promise<Record<string, unknown>[] | null> {
  const allRecords: Record<string, unknown>[] = [];
  let offset = 0;
  let total = Infinity;
  let pageCount = 0;

  while (offset < total && pageCount < MAX_PAGES) {
    pageCount++;
    const result = await apiRequest<Record<string, unknown>>(
      "GET",
      `${config.apiPath}?limit=${MAX_PAGE_SIZE}&offset=${offset}`,
    );

    if (!result.ok) {
      return null;
    }

    const data = result.data;
    const records = data[config.recordsKey];
    if (!Array.isArray(records)) {
      console.warn(
        `  WARN: Expected array at key "${config.recordsKey}" for ${config.table}, got ${typeof records}`,
      );
      return null;
    }

    allRecords.push(...records);
    total = typeof data.total === "number" ? data.total : allRecords.length;
    offset += MAX_PAGE_SIZE;

    // If we got fewer records than page size, we're done
    if (records.length < MAX_PAGE_SIZE) break;
  }

  return allRecords;
}

/**
 * Validate all records from one table config.
 */
export function validateRecords(
  config: TableConfig,
  records: Record<string, unknown>[],
): TemporalViolation[] {
  const violations: TemporalViolation[] = [];

  for (const record of records) {
    const id = String(record.id ?? "unknown");

    if (config.kind === "pair") {
      const startVal = record[config.startField];
      const endVal = record[config.endField];
      violations.push(
        ...validateDatePair(
          config.table,
          id,
          config.startField,
          typeof startVal === "string" ? startVal : null,
          config.endField,
          typeof endVal === "string" ? endVal : null,
        ),
      );
    } else {
      const dateVal = record[config.dateField];
      if (typeof dateVal === "string" && dateVal.length > 0) {
        violations.push(
          ...validateDateField(config.table, id, config.dateField, dateVal),
        );
      }
    }
  }

  return violations;
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
  if (!serverUrl) {
    if (!ciMode) {
      console.log(
        `${colors.dim}PG temporal check skipped — LONGTERMWIKI_SERVER_URL not set${colors.reset}`,
      );
    }
    return { passed: true, errors: 0, warnings: 1 };
  }

  if (!ciMode) {
    console.log(
      `${colors.blue}Checking PG temporal consistency...${colors.reset}\n`,
    );
  }

  const allViolations: TemporalViolation[] = [];
  let tablesChecked = 0;
  let totalRecords = 0;
  let serverUnavailable = false;

  for (const config of TABLE_CONFIGS) {
    const records = await fetchAllRecords(config);

    if (records === null) {
      // First table failure — check if server is unreachable
      if (tablesChecked === 0) {
        serverUnavailable = true;
        break;
      }
      // Partial failure — log and continue with other tables
      if (!ciMode) {
        console.log(
          `${colors.yellow}  Skipping ${config.table} — API unavailable${colors.reset}`,
        );
      }
      continue;
    }

    tablesChecked++;
    totalRecords += records.length;

    const violations = validateRecords(config, records);
    allViolations.push(...violations);

    if (!ciMode) {
      const violationCount = violations.length;
      if (violationCount === 0) {
        console.log(
          `  ${colors.green}✓${colors.reset} ${config.table}: ${records.length} records OK`,
        );
      } else {
        console.log(
          `  ${colors.yellow}⚠${colors.reset} ${config.table}: ${violationCount} issue(s) in ${records.length} records`,
        );
      }
    }
  }

  if (serverUnavailable) {
    if (!ciMode) {
      console.log(
        `${colors.yellow}  Wiki-server unavailable — skipping PG temporal check${colors.reset}`,
      );
    }
    return { passed: true, errors: 0, warnings: 1 };
  }

  // Summarize
  const errorCount = allViolations.filter((v) => v.severity === "error").length;
  const warningCount = allViolations.filter(
    (v) => v.severity === "warning",
  ).length;

  if (ciMode) {
    console.log(
      JSON.stringify(
        {
          tablesChecked,
          totalRecords,
          errors: errorCount,
          warnings: warningCount,
          violations: allViolations,
        },
        null,
        2,
      ),
    );
  } else {
    if (allViolations.length === 0) {
      console.log(
        `\n${colors.green}✓ No temporal issues found across ${tablesChecked} tables (${totalRecords} records)${colors.reset}`,
      );
    } else {
      console.log(
        `\n${colors.yellow}Found ${allViolations.length} temporal issue(s):${colors.reset}\n`,
      );

      // Group by table for readability
      const byTable = new Map<string, TemporalViolation[]>();
      for (const v of allViolations) {
        const list = byTable.get(v.table) ?? [];
        list.push(v);
        byTable.set(v.table, list);
      }

      for (const [table, violations] of byTable) {
        console.log(`  ${colors.bold}${table}:${colors.reset}`);
        for (const v of violations) {
          const icon =
            v.severity === "error"
              ? `${colors.red}✗`
              : `${colors.yellow}⚠`;
          console.log(
            `    ${icon}${colors.reset} [${v.recordId}] ${v.field}: ${v.issue}`,
          );
          console.log(`      ${colors.dim}value: ${v.value}${colors.reset}`);
        }
      }

      console.log(
        `\n${"─".repeat(50)}`,
      );
      console.log(
        `Tables: ${tablesChecked}, Records: ${totalRecords}, Errors: ${errorCount}, Warnings: ${warningCount}`,
      );
    }
  }

  return {
    passed: errorCount === 0,
    errors: errorCount,
    warnings: warningCount,
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
