import { sql } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type * as schema from "../../schema.js";
import type { InlineSourcing } from "./sourcing-schema.js";
import { logger } from "../../logger.js";
import { recomputeVerdict } from "../sourcing/recompute-verdict.js";

type DbOrTx =
  | import("drizzle-orm/postgres-js").PostgresJsDatabase<typeof schema>
  | PgTransaction<
      PostgresJsQueryResultHKT,
      typeof schema,
      ExtractTablesWithRelations<typeof schema>
    >;

/**
 * Write source_check_verdicts for records that include inline sourcing data.
 * Called within a sync handler's transaction.
 *
 * Uses the same upsert pattern as sourcing.ts verdict writes:
 *   - Verdicts keyed on (record_type, record_id, COALESCE(field_name, ''))
 *   - Evidence keyed on (record_type, record_id, COALESCE(source_url, ''), COALESCE(checker_model, ''))
 */
export async function writeInlineVerdicts(
  tx: DbOrTx,
  records: Array<{
    recordType: string;
    recordId: string;
    entityId?: string | null;
    sourceUrl?: string | null;
    sourcing?: InlineSourcing | null;
  }>
): Promise<{ written: number }> {
  const withSourcing = records.filter((r) => r.sourcing);
  if (withSourcing.length === 0) return { written: 0 };

  for (const record of withSourcing) {
    const v = record.sourcing!;

    // Upsert verdict — same conflict key as sourcing.ts
    // Note: `reasoning` is the verdict-level summary (not raw evidence text).
    // Raw evidence goes in source_check_evidence.extracted_quote.
    const reasoning = v.evidence
      ? `Inline sourcing: ${v.verdict}. Evidence: ${v.evidence.slice(0, 500)}`
      : `Inline sourcing: ${v.verdict}`;
    await tx.execute(sql`
      INSERT INTO source_check_verdicts (
        record_type, record_id, field_name, entity_id,
        verdict, confidence, reasoning, sources_checked,
        needs_recheck, next_check_due,
        last_computed_at, created_at, updated_at
      ) VALUES (
        ${record.recordType},
        ${record.recordId},
        NULL,
        ${record.entityId ?? null},
        ${v.verdict},
        ${v.confidence ?? null},
        ${reasoning},
        1,
        false,
        NOW() + INTERVAL '90 days',
        NOW(), NOW(), NOW()
      )
      ON CONFLICT (record_type, record_id, COALESCE(field_name, ''))
      DO UPDATE SET
        verdict = EXCLUDED.verdict,
        confidence = EXCLUDED.confidence,
        reasoning = EXCLUDED.reasoning,
        sources_checked = EXCLUDED.sources_checked,
        needs_recheck = false,
        next_check_due = NOW() + INTERVAL '90 days',
        last_computed_at = NOW(),
        updated_at = NOW()
    `);

    // Also write evidence row if we have a source URL
    if (record.sourceUrl) {
      await tx.execute(sql`
        INSERT INTO source_check_evidence (
          record_type, record_id, field_name, entity_id,
          source_url, verdict, confidence,
          extracted_quote, checker_model,
          checked_at, created_at, updated_at
        ) VALUES (
          ${record.recordType},
          ${record.recordId},
          NULL,
          ${record.entityId ?? null},
          ${record.sourceUrl},
          ${v.verdict},
          ${v.confidence ?? null},
          ${v.evidence ?? null},
          ${v.checkedBy ?? "inline-submission"},
          ${v.checkedAt ? sql`${v.checkedAt}::timestamptz` : sql`NOW()`},
          NOW(), NOW()
        )
        ON CONFLICT (record_type, record_id, COALESCE(source_url, ''), COALESCE(checker_model, ''))
        DO UPDATE SET
          verdict = EXCLUDED.verdict,
          confidence = EXCLUDED.confidence,
          extracted_quote = EXCLUDED.extracted_quote,
          checked_at = EXCLUDED.checked_at,
          updated_at = NOW()
      `);
    }

    // QUA-791: reconcile the just-written verdict against all evidence
    // rows for this record. Without this, the verdict above is whatever
    // this single inline-sourcing call passed in (last-writer-wins).
    //
    // **Not best-effort** — runs inside the enclosing tx; a swallowed
    // error would risk 25P02 cascades on subsequent statements once
    // postgres marks the tx aborted. Letting errors propagate gives a
    // clean rollback of the entire inline-verdict write.
    await recomputeVerdict(tx, {
      recordType: record.recordType,
      recordId: record.recordId,
      fieldName: null,
      entityId: record.entityId ?? null,
    });
  }

  return { written: withSourcing.length };
}

/**
 * Log a warning when records are submitted without sourcing data.
 * Call this from sync handlers for visibility into sourcing coverage.
 */
export function logSourcingCoverage(
  endpoint: string,
  totalItems: number,
  checkedCount: number
): void {
  if (checkedCount === 0) {
    // Debug-level: sourcing is optional today, so missing sourcing is expected.
    // Upgrade to warn once sourcing is mandatory.
    logger.debug(
      { endpoint, totalItems },
      `${endpoint}: all ${totalItems} records submitted without sourcing`
    );
  } else if (checkedCount < totalItems) {
    logger.info(
      { endpoint, totalItems, checkedCount },
      `${endpoint}: ${checkedCount}/${totalItems} records include sourcing`
    );
  }
}
