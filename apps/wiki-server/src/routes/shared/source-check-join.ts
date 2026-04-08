/**
 * Shared helpers for LEFT JOINing source_check_verdicts into queries
 * and formatting the result into the API response shape.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Column } from "drizzle-orm";
import { sourceVerdicts } from "../../schema.js";

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
