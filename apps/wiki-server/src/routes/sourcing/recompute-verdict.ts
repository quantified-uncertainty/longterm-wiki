/**
 * Recompute a `source_check_verdicts` row from its underlying
 * `source_check_evidence` rows (QUA-791 Phase 1).
 *
 * The single canonical aggregator. Every code path that wants to derive
 * an aggregate verdict from raw evidence MUST go through this helper.
 *
 * Replaces the pre-Phase-1 last-writer-wins behavior at `POST /verdicts`,
 * which let whoever wrote last set the aggregate regardless of what the
 * other evidence rows said.
 */

import { eq, and, sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import * as schema from "../../schema.js";
import { recordSources, sourceVerdicts } from "../../schema.js";
import {
  aggregateEvidence,
  type EvidenceRow,
  type AggregationResult,
} from "./sourcing-aggregation.js";
import { logger } from "../../logger.js";

/**
 * Accept either a top-level Drizzle DB or a transaction handle. Same
 * pattern used by `routes/tablebase/audit-log.ts::logAuditEntries`.
 * Lets callers atomically write evidence + recompute verdict in one tx.
 */
type Db =
  | import("drizzle-orm/postgres-js").PostgresJsDatabase<typeof schema>
  | PgTransaction<
      PostgresJsQueryResultHKT,
      typeof schema,
      ExtractTablesWithRelations<typeof schema>
    >;

export interface RecomputeArgs {
  recordType: string;
  recordId: string;
  /** NULL = whole-row verdict; otherwise the field-level verdict for this column. */
  fieldName?: string | null;
  /**
   * Optional metadata to persist alongside the recomputed verdict. These
   * are pass-through fields from the evidence-writer; recompute does not
   * derive them from evidence rows. Display names already on the row
   * are preserved when these are not supplied (COALESCE pattern).
   */
  entityId?: string | null;
  displayName?: string | null;
  entityDisplayName?: string | null;
}

export interface RecomputeResult {
  recordType: string;
  recordId: string;
  fieldName: string | null;
  aggregate: AggregationResult;
  /**
   * Reasoning string written to `source_check_verdicts.reasoning`. Empty
   * when the aggregate is `unchecked`.
   */
  reasoning: string;
}

/**
 * Read evidence rows for a single (recordType, recordId, fieldName) key
 * and return them in a plain shape that `aggregateEvidence` accepts.
 *
 * `fieldName` matching uses `COALESCE(field_name, '')` so that NULL
 * (whole-row) and a missing fieldName argument match each other but
 * not a specific field's evidence.
 */
async function loadEvidenceRows(
  db: Db,
  args: { recordType: string; recordId: string; fieldName: string | null },
): Promise<EvidenceRow[]> {
  const fieldNameForLookup = args.fieldName ?? "";
  const rows = await db
    .select({
      verdict: recordSources.verdict,
      relevanceScore: recordSources.relevanceScore,
      confidence: recordSources.confidence,
    })
    .from(recordSources)
    .where(
      and(
        eq(recordSources.recordType, args.recordType),
        eq(recordSources.recordId, args.recordId),
        sql`COALESCE(${recordSources.fieldName}, '') = ${fieldNameForLookup}`,
      ),
    );
  return rows.map((r) => ({
    verdict: r.verdict as EvidenceRow["verdict"],
    relevanceScore: r.relevanceScore,
    confidence: r.confidence,
  }));
}

/**
 * Build the human-readable `reasoning` string written to
 * `source_check_verdicts.reasoning`. Reflects the aggregator's input so
 * the disagree-warning surface (QUA-792 Phase 3) can read the same
 * computation without re-deriving it.
 */
function buildReasoning(aggregate: AggregationResult): string {
  if (aggregate.verdict === "unchecked") {
    if (aggregate.sourcesChecked === 0) {
      return aggregate.droppedNotApplicable > 0
        ? `All ${aggregate.droppedNotApplicable} source(s) were filtered as not_applicable.`
        : "No evidence rows available.";
    }
    return `${aggregate.sourcesChecked} source(s) checked but none were relevant enough to draw a conclusion.`;
  }
  const winner = aggregate.contributing[0];
  const dissent = aggregate.contributing.slice(1);
  const winnerStr = `${winner.rowCount} source(s) → ${winner.verdict}`;
  if (dissent.length === 0) return winnerStr;
  const dissentStr = dissent
    .map((d) => `${d.rowCount} → ${d.verdict}`)
    .join(", ");
  return `${winnerStr}; dissent: ${dissentStr}`;
}

/**
 * Recompute the aggregate verdict for one `(recordType, recordId, fieldName)`
 * key and upsert into `source_check_verdicts`.
 *
 * Returns the new aggregate. Safe to call repeatedly — idempotent up to
 * `updated_at` and `last_computed_at` timestamps.
 *
 * Uses an UPDATE-then-INSERT-fallback pattern (matching the existing
 * `POST /verdicts` handler) to avoid driver-level issues with
 * `ON CONFLICT (..., COALESCE(field_name, ''), ...)` expressions.
 */
export async function recomputeVerdict(
  db: Db,
  args: RecomputeArgs,
): Promise<RecomputeResult> {
  const fieldName = args.fieldName ?? null;
  const fieldNameForLookup = fieldName ?? "";
  const evidence = await loadEvidenceRows(db, {
    recordType: args.recordType,
    recordId: args.recordId,
    fieldName,
  });
  const aggregate = aggregateEvidence(evidence);
  const result: RecomputeResult = {
    recordType: args.recordType,
    recordId: args.recordId,
    fieldName,
    aggregate,
    reasoning: buildReasoning(aggregate),
  };

  const now = new Date();

  // Try UPDATE first. On no match, INSERT. Race-safe via the
  // unique-violation retry pattern used by the rest of this module.
  // COALESCE the optional metadata fields so re-running recompute
  // without them doesn't blow away previously-persisted display names.
  const updated = await db
    .update(sourceVerdicts)
    .set({
      verdict: aggregate.verdict,
      confidence: aggregate.confidence,
      reasoning: result.reasoning,
      sourcesChecked: aggregate.sourcesChecked,
      // Recompute clears the recheck flag — we just looked.
      needsRecheck: false,
      lastComputedAt: now,
      updatedAt: now,
      ...(args.entityId !== undefined ? { entityId: args.entityId } : {}),
      ...(args.displayName !== undefined ? { displayName: args.displayName } : {}),
      ...(args.entityDisplayName !== undefined
        ? { entityDisplayName: args.entityDisplayName }
        : {}),
    })
    .where(
      and(
        eq(sourceVerdicts.recordType, args.recordType),
        eq(sourceVerdicts.recordId, args.recordId),
        sql`COALESCE(${sourceVerdicts.fieldName}, '') = ${fieldNameForLookup}`,
      ),
    )
    .returning({ recordId: sourceVerdicts.recordId });

  if (updated.length > 0) return result;

  // Insert fresh row. If a concurrent call beat us to it, the unique
  // index throws and we retry with UPDATE.
  try {
    await db.insert(sourceVerdicts).values({
      recordType: args.recordType,
      recordId: args.recordId,
      fieldName,
      entityId: args.entityId ?? null,
      displayName: args.displayName ?? null,
      entityDisplayName: args.entityDisplayName ?? null,
      verdict: aggregate.verdict,
      confidence: aggregate.confidence,
      reasoning: result.reasoning,
      sourcesChecked: aggregate.sourcesChecked,
      needsRecheck: false,
      lastComputedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("unique") || msg.includes("duplicate") || msg.includes("23505")) {
      await db
        .update(sourceVerdicts)
        .set({
          verdict: aggregate.verdict,
          confidence: aggregate.confidence,
          reasoning: result.reasoning,
          sourcesChecked: aggregate.sourcesChecked,
          needsRecheck: false,
          lastComputedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(sourceVerdicts.recordType, args.recordType),
            eq(sourceVerdicts.recordId, args.recordId),
            sql`COALESCE(${sourceVerdicts.fieldName}, '') = ${fieldNameForLookup}`,
          ),
        );
      return result;
    }
    throw err;
  }
}

/**
 * Best-effort wrapper used by evidence-writer code paths. Logs and swallows
 * errors so a failed recompute doesn't break the underlying write — the
 * verdict will be picked up by the next recompute call instead.
 */
export async function recomputeVerdictBestEffort(
  db: Db,
  args: RecomputeArgs,
): Promise<void> {
  try {
    await recomputeVerdict(db, args);
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        recordType: args.recordType,
        recordId: args.recordId,
        fieldName: args.fieldName ?? null,
      },
      "recomputeVerdict failed (best-effort wrapper)",
    );
  }
}
