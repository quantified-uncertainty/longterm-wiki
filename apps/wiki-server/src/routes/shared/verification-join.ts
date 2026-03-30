/**
 * Shared helpers for LEFT JOINing source_check_verdicts into queries
 * and formatting the result into the API response shape.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Column } from "drizzle-orm";
import { sourceCheckVerdicts } from "../../schema.js";

/**
 * Build the LEFT JOIN condition for source_check_verdicts.
 * Matches whole-row verdicts (field_name IS NULL) for a given record type and ID column.
 */
export function verdictJoinCondition(recordType: string, idColumn: Column) {
  return and(
    eq(sourceCheckVerdicts.recordType, recordType),
    eq(sourceCheckVerdicts.recordId, idColumn),
    sql`${sourceCheckVerdicts.fieldName} IS NULL`,
  );
}

/** Fields to include in the SELECT when joining source_check_verdicts. */
export const verdictSelectFields = {
  verificationVerdict: sourceCheckVerdicts.verdict,
  verificationConfidence: sourceCheckVerdicts.confidence,
  verificationSourcesChecked: sourceCheckVerdicts.sourcesChecked,
  verificationCheckedAt: sourceCheckVerdicts.lastComputedAt,
};

/** Shape of the verdict fields after selection. */
export interface VerdictJoinFields {
  verificationVerdict: string | null;
  verificationConfidence: number | null;
  verificationSourcesChecked: number | null;
  verificationCheckedAt: Date | null;
}

/** Format joined verdict fields into the API response shape. Returns null if no verdict. */
export function formatVerification(row: VerdictJoinFields) {
  if (!row.verificationVerdict) return null;
  return {
    verdict: row.verificationVerdict,
    confidence: row.verificationConfidence,
    sourcesChecked: row.verificationSourcesChecked ?? 0,
    checkedAt: row.verificationCheckedAt?.toISOString() ?? null,
  };
}
