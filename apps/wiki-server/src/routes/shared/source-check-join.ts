/**
 * Shared helpers for LEFT JOINing source_check_verdicts into queries
 * and formatting the result into the API response shape.
 */
import { and, eq, isNotNull, inArray, sql } from "drizzle-orm";
import type { Column } from "drizzle-orm";
import { sourceVerdicts } from "../../schema.js";
import { getDrizzleDb } from "../../db.js";

/**
 * Build the LEFT JOIN condition for source_check_verdicts.
 * Matches whole-row verdicts (field_name IS NULL) for a given record type and ID column.
 */
export function verdictJoinCondition(recordType: string, idColumn: Column) {
  return and(
    eq(sourceVerdicts.recordType, recordType),
    eq(sourceVerdicts.recordId, idColumn),
    sql`${sourceVerdicts.fieldName} IS NULL`,
  );
}

/** Fields to include in the SELECT when joining source_check_verdicts. */
export const verdictSelectFields = {
  sourcingVerdict: sourceVerdicts.verdict,
  sourcingConfidence: sourceVerdicts.confidence,
  sourcingSourcesChecked: sourceVerdicts.sourcesChecked,
  sourcingCheckedAt: sourceVerdicts.lastComputedAt,
};

/** Shape of the verdict fields after selection. */
export interface VerdictJoinFields {
  sourcingVerdict: string | null;
  sourcingConfidence: number | null;
  sourcingSourcesChecked: number | null;
  sourcingCheckedAt: Date | null;
}

/** Format joined verdict fields into the API response shape. Returns null if no verdict. */
export function formatSourcing(row: VerdictJoinFields) {
  if (!row.sourcingVerdict) return null;
  return {
    verdict: row.sourcingVerdict,
    confidence: row.sourcingConfidence,
    sourcesChecked: row.sourcingSourcesChecked ?? 0,
    checkedAt: row.sourcingCheckedAt?.toISOString() ?? null,
  };
}

/** A single per-field verdict row from the database. */
export interface FieldVerdictRow {
  recordId: string;
  fieldName: string;
  verdict: string;
  confidence: number | null;
  lastComputedAt: Date | null;
}

/** Per-field verdicts grouped by recordId. */
export type FieldVerdictsByRecord = Map<string, FieldVerdictRow[]>;

/**
 * Fetch per-field verdicts for a set of records.
 * Returns verdicts where field_name IS NOT NULL, grouped by record_id.
 *
 * This is separate from the row-level verdict JOIN (which filters field_name IS NULL)
 * so that callers can render both the row-level verdict and per-field breakdowns.
 */
export async function fetchFieldVerdicts(
  recordType: string,
  recordIds: string[],
): Promise<FieldVerdictsByRecord> {
  if (recordIds.length === 0) return new Map();

  const db = getDrizzleDb();
  const rows = await db
    .select({
      recordId: sourceVerdicts.recordId,
      fieldName: sourceVerdicts.fieldName,
      verdict: sourceVerdicts.verdict,
      confidence: sourceVerdicts.confidence,
      lastComputedAt: sourceVerdicts.lastComputedAt,
    })
    .from(sourceVerdicts)
    .where(
      and(
        eq(sourceVerdicts.recordType, recordType),
        inArray(sourceVerdicts.recordId, recordIds),
        isNotNull(sourceVerdicts.fieldName),
      ),
    )
    .orderBy(sourceVerdicts.recordId, sourceVerdicts.fieldName);

  const result: FieldVerdictsByRecord = new Map();
  for (const row of rows) {
    const entry: FieldVerdictRow = {
      recordId: row.recordId,
      fieldName: row.fieldName!,
      verdict: row.verdict,
      confidence: row.confidence,
      lastComputedAt: row.lastComputedAt,
    };
    const existing = result.get(row.recordId);
    if (existing) {
      existing.push(entry);
    } else {
      result.set(row.recordId, [entry]);
    }
  }

  return result;
}
