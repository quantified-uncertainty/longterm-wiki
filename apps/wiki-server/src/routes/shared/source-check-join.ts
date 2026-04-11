/**
 * Shared helpers for LEFT JOINing source_check_verdicts into queries
 * and formatting the result into the API response shape.
 */
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Column } from "drizzle-orm";
import { sourceVerdicts } from "../../schema.js";
import type { getDrizzleDb } from "../../db.js";
import { sqlInList } from "./query-helpers.js";

/**
 * Build the LEFT JOIN condition for source_check_verdicts.
 * Matches whole-row verdicts (field_name IS NULL) for a given record type and ID column.
 */
export function verdictJoinCondition(recordType: string, idColumn: Column) {
  return and(
    eq(sourceVerdicts.recordType, recordType),
    eq(sourceVerdicts.recordId, idColumn),
    isNull(sourceVerdicts.fieldName),
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

/** Per-field verdict shape returned by fetchFieldVerdicts(). */
export interface FieldVerdict {
  verdict: string;
  confidence: number | null;
  sourcesChecked: number;
  checkedAt: string | null;
}

/**
 * Fetch per-field verdicts for a batch of records of a given record type.
 * Returns a map keyed by recordId -> { fieldName -> FieldVerdict }.
 *
 * This queries source_check_verdicts WHERE field_name IS NOT NULL,
 * filtering to only per-field (not whole-row) verdicts.
 */
export async function fetchFieldVerdicts(
  db: ReturnType<typeof getDrizzleDb>,
  recordType: string,
  recordIds: string[],
): Promise<Record<string, Record<string, FieldVerdict>>> {
  if (recordIds.length === 0) return {};

  const rows = await db
    .select({
      recordId: sourceVerdicts.recordId,
      fieldName: sourceVerdicts.fieldName,
      verdict: sourceVerdicts.verdict,
      confidence: sourceVerdicts.confidence,
      sourcesChecked: sourceVerdicts.sourcesChecked,
      lastComputedAt: sourceVerdicts.lastComputedAt,
    })
    .from(sourceVerdicts)
    .where(
      and(
        eq(sourceVerdicts.recordType, recordType),
        sql`${sourceVerdicts.recordId} IN (${sqlInList(recordIds)})`,
        isNotNull(sourceVerdicts.fieldName),
      ),
    );

  const result: Record<string, Record<string, FieldVerdict>> = {};
  for (const row of rows) {
    if (!row.fieldName) continue;
    if (!result[row.recordId]) {
      result[row.recordId] = {};
    }
    result[row.recordId][row.fieldName] = {
      verdict: row.verdict,
      confidence: row.confidence,
      sourcesChecked: row.sourcesChecked,
      checkedAt: row.lastComputedAt?.toISOString() ?? null,
    };
  }
  return result;
}
