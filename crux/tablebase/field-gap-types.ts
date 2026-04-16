/**
 * Field-gap types — contract between the scanner (QUA-551) and the improve
 * pipeline (QUA-552).
 *
 * The scanner produces `FieldGapReport` via `crux tb tablebase scan --fields --json`.
 * The improve pipeline consumes it via `crux tb improve --from-scan-report=<path>`.
 *
 * Loader is permissive on additional fields so the scanner can attach
 * scanner-specific metadata (severity, suggested-task-type, etc.) without
 * breaking compatibility.
 */

import type { TaskType } from './types.ts';

/** A single field gap identified by the scanner. */
export interface FieldGap {
  /** Canonical table name (hyphenated or underscored — normalized at load time). */
  table: string;
  /** Column name, camelCase or snake_case as it appears in the schema. */
  field: string;
  /** Number of rows where the field is null / empty. */
  nullCount: number;
  /** 0-100 percent of rows with a null value for the field. */
  nullPercent: number;
  /** Total row count in the table (denominator for nullPercent). */
  totalRows: number;
  /** Optional narrowing — specific row IDs the scanner recommends targeting. */
  targetRowIds?: string[];
}

/** A scanner field-gap report. */
export interface FieldGapReport {
  /** ISO timestamp of when the scan was produced. */
  timestamp: string;
  /** Gaps discovered by the scanner. */
  gaps: FieldGap[];
}

/**
 * Map a (table, field) pair to the enrichment task type that knows how to
 * fill it. Returns null if no mapping is known — the caller decides whether
 * that's an error or a skip.
 *
 * Keep this in sync with `tableToTaskType` in task-ranker.ts and the prompts
 * in prompts.ts. When QUA-33 (playbook library) lands, this dispatch table
 * becomes per-field instead of per-table.
 */
export function fieldToTaskType(table: string, field: string): TaskType | null {
  const canonicalTable = canonicalizeTable(table);
  const canonicalField = canonicalizeField(field);
  const key = `${canonicalTable}.${canonicalField}`;

  switch (key) {
    // Divisions
    case 'divisions.lead_id':
    case 'divisions.lead':
      return 'division-lead-fill';

    // Division personnel
    case 'division_personnel.start_date':
    case 'division_personnel.end_date':
      return 'division-personnel-dates';

    // Funding programs
    case 'funding_programs.total_budget':
    case 'funding_programs.deadline':
    case 'funding_programs.application_url':
      return 'funding-program-enrichment';

    // Benchmark results
    case 'benchmark_results.source_url':
      return 'benchmark-source-fill';

    // Grants
    case 'grants.grantee_id':
      return 'grant-grantee-backfill';

    default:
      return null;
  }
}

/**
 * Parse a scanner field-gap report from a JSON file. Accepts either the
 * full FieldGapReport shape or a bare FieldGap[] array (scanner is free to
 * output either).
 *
 * Fails closed on malformed input — this is plumbing, not content, and a
 * silent no-op would mask upstream bugs.
 */
export function parseFieldGapReport(json: string): FieldGapReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`Invalid JSON in scan report: ${err instanceof Error ? err.message : String(err)}`);
  }

  const gaps = Array.isArray(parsed)
    ? parsed
    : (parsed as { gaps?: unknown }).gaps;

  if (!Array.isArray(gaps)) {
    throw new Error('Scan report must be an array of gaps or { gaps: [...] }');
  }

  const validated: FieldGap[] = [];
  for (const raw of gaps) {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`Invalid gap entry (not an object): ${JSON.stringify(raw)}`);
    }
    const g = raw as Record<string, unknown>;
    if (typeof g.table !== 'string' || typeof g.field !== 'string') {
      throw new Error(`Gap missing required 'table' or 'field': ${JSON.stringify(g)}`);
    }
    validated.push({
      table: g.table,
      field: g.field,
      nullCount: typeof g.nullCount === 'number' ? g.nullCount : 0,
      nullPercent: typeof g.nullPercent === 'number' ? g.nullPercent : 0,
      totalRows: typeof g.totalRows === 'number' ? g.totalRows : 0,
      targetRowIds: Array.isArray(g.targetRowIds)
        ? g.targetRowIds.filter((id): id is string => typeof id === 'string')
        : undefined,
    });
  }

  const timestamp = !Array.isArray(parsed) && typeof (parsed as { timestamp?: unknown }).timestamp === 'string'
    ? ((parsed as { timestamp: string }).timestamp)
    : new Date().toISOString();

  return { timestamp, gaps: validated };
}

/** Normalize a table name (hyphen or underscore) to its underscored form. */
function canonicalizeTable(table: string): string {
  return table.replace(/-/g, '_').toLowerCase();
}

/** Normalize a field name (camelCase or snake_case) to its snake_case form. */
function canonicalizeField(field: string): string {
  return field
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();
}
