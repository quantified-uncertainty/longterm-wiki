/**
 * Recompute a `source_check_verdicts` row from its underlying
 * `source_check_evidence` rows. The canonical write path: every code path
 * that derives an aggregate verdict from raw evidence MUST go through here.
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
import { isStaleModel } from "./checker-model.js";
import { logger } from "../../logger.js";

/**
 * Detect a postgres unique-violation. Drizzle wraps postgres-js errors as
 * `Error("Failed query: ...")` with the original on `.cause`, so checking
 * only `err.message` misses the signal. Check `code === '23505'` and the
 * canonical substrings on both the top-level error and its cause.
 */
function isUniqueViolation(err: unknown): boolean {
  const matches = (e: unknown): boolean => {
    if (!e) return false;
    if ((e as { code?: string }).code === "23505") return true;
    const msg = e instanceof Error ? e.message : "";
    return msg.includes("23505") || msg.includes("unique") || msg.includes("duplicate");
  };
  return matches(err) || matches((err as { cause?: unknown } | null)?.cause);
}

/**
 * Accept either a top-level Drizzle DB or a transaction handle so callers
 * can write evidence + recompute the verdict atomically in one tx.
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
      // QUA-992: aggregation tie-breaker prefers the bucket whose latest
      // evidence is most recent. Required so a fresh re-check supersedes
      // stale evidence at equal weight.
      checkedAt: recordSources.checkedAt,
      // QUA-991: needed so the aggregator can drop stale evidence when a
      // fresh re-check is present. NULL counts as stale.
      checkerModel: recordSources.checkerModel,
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
    checkedAt: r.checkedAt,
    isStale: isStaleModel(r.checkerModel),
  }));
}

/**
 * Human-readable `reasoning` string for `source_check_verdicts.reasoning`.
 * Reflects the aggregator's contributing breakdown so the disagree-warning
 * surface (QUA-792) can render the same computation without re-deriving it.
 *
 * QUA-991: when stale rows were excluded from the headline because a fresh
 * row was present, append them as a separate clause so an operator inspecting
 * the reasoning can see why a previously-`partial` record now reads as
 * `confirmed`.
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
  const fmt = (c: { rowCount: number; verdict: string }) =>
    `${c.rowCount} → ${c.verdict}`;
  const [winner, ...dissent] = aggregate.contributing;
  const parts = [fmt(winner)];
  if (dissent.length > 0) parts.push(`dissent: ${dissent.map(fmt).join(", ")}`);
  if (aggregate.droppedStale.length > 0) {
    parts.push(`stale (excluded): ${aggregate.droppedStale.map(fmt).join(", ")}`);
  }
  return parts.join("; ");
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

  // No evidence at all → don't write a verdict row. Preserves back-compat
  // for callers that use POST /verdicts as a verdict-only marker write
  // (no evidence to roll up). When evidence later exists, the next
  // POST /evidence call's recompute will populate the row.
  if (evidence.length === 0) return result;

  const now = new Date();

  // Try UPDATE first. On no match, INSERT. Race-safe via the
  // unique-violation retry pattern used by the rest of this module.
  // The metadata fields use the conditional-spread idiom so that
  // `undefined` (caller omitted the field) preserves the existing DB
  // value, while explicit `null` clears it. Callers like
  // writeInlineVerdicts omit display-name fields and rely on existing
  // values being kept; POST /verdicts/recompute may pass null explicitly
  // (e.g. coerceDisplayName scrubbed a leaked sid_) and expects a clear.
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

  // INSERT fresh row; on race-loss to a concurrent INSERT, retry as UPDATE.
  // 90-day `next_check_due` matches POST /verdicts and writeInlineVerdicts
  // so recompute-inserted rows participate in the `due-for-recheck` cycle.
  const ninetyDays = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
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
      nextCheckDue: ninetyDays,
      lastComputedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return result;
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
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
