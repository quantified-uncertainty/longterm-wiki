import { sql } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type * as schema from "../../schema.js";
import type { InlineVerification } from "./verification-schema.js";
import { logger } from "../../logger.js";

type DbOrTx =
  | import("drizzle-orm/postgres-js").PostgresJsDatabase<typeof schema>
  | PgTransaction<
      PostgresJsQueryResultHKT,
      typeof schema,
      ExtractTablesWithRelations<typeof schema>
    >;

/**
 * Write source_check_verdicts for records that include inline verification data.
 * Called within a sync handler's transaction.
 *
 * Uses the same upsert pattern as source-checks.ts verdict writes:
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
    verification?: InlineVerification | null;
  }>
): Promise<{ written: number }> {
  const withVerification = records.filter((r) => r.verification);
  if (withVerification.length === 0) return { written: 0 };

  for (const record of withVerification) {
    const v = record.verification!;

    // Upsert verdict — same conflict key as source-checks.ts
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
        ${v.evidence ?? null},
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
        sources_checked = source_check_verdicts.sources_checked + 1,
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
  }

  return { written: withVerification.length };
}

/**
 * Log a warning when records are submitted without verification data.
 * Call this from sync handlers for visibility into verification coverage.
 */
export function logVerificationCoverage(
  endpoint: string,
  totalItems: number,
  verifiedCount: number
): void {
  if (verifiedCount === 0) {
    logger.warn(
      { endpoint, totalItems },
      `${endpoint}: all ${totalItems} records submitted without verification`
    );
  } else if (verifiedCount < totalItems) {
    logger.info(
      { endpoint, totalItems, verifiedCount },
      `${endpoint}: ${verifiedCount}/${totalItems} records include verification`
    );
  }
}
