/**
 * record-attempts — stamp the sourcing_attempts ledger (QUA-1071).
 *
 * The backfill-sources job calls this once per processed record (matched or
 * not) so the missing-sources queries can skip records re-attempted within a
 * retry window. One upsert per (table_name, record_id): first attempt inserts
 * with attempt_count = 1, repeats bump the count and refresh the timestamp.
 */

import { sql } from "drizzle-orm";
import { sourcingAttempts } from "../../../schema.js";
import type { Db } from "./queries.js";

export interface AttemptInput {
  table: string;
  recordId: string;
  outcome: string;
}

/**
 * Upsert a batch of attempts in one statement. Returns the number of rows
 * written. An empty batch is a no-op (returns 0).
 */
export async function recordAttempts(db: Db, items: AttemptInput[]): Promise<number> {
  if (items.length === 0) return 0;

  const rows = items.map((it) => ({
    tableName: it.table,
    recordId: it.recordId,
    lastOutcome: it.outcome,
  }));

  const res = await db
    .insert(sourcingAttempts)
    .values(rows)
    .onConflictDoUpdate({
      target: [sourcingAttempts.tableName, sourcingAttempts.recordId],
      set: {
        lastAttemptAt: sql`now()`,
        attemptCount: sql`${sourcingAttempts.attemptCount} + 1`,
        lastOutcome: sql`excluded.last_outcome`,
      },
    })
    .returning({ recordId: sourcingAttempts.recordId });

  return res.length;
}
