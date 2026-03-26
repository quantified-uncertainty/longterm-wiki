/**
 * Shared audit logging utility for TableBase changes.
 *
 * Any sync handler can call `logAuditEntries(tx, entries)` inside its
 * transaction to record inserts/updates/deletes to the audit log.
 */

import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type * as schema from "../../schema.js";
import { tablebaseAuditLog } from "../../schema.js";

type DbOrTx =
  | import("drizzle-orm/postgres-js").PostgresJsDatabase<typeof schema>
  | PgTransaction<
      PostgresJsQueryResultHKT,
      typeof schema,
      ExtractTablesWithRelations<typeof schema>
    >;

/**
 * A single audit log entry to record a TableBase change.
 */
export interface AuditEntry {
  recordType: string;
  recordId: string;
  operation: "insert" | "update" | "delete";
  oldData?: Record<string, unknown> | null;
  newData: Record<string, unknown>;
  sourceUrl?: string | null;
  verdict?: string | null;
  evidence?: string | null;
  agentSessionId?: string | null;
  prNumber?: number | null;
}

/**
 * Log a batch of TableBase changes to the audit log.
 * Call this inside the sync handler's transaction.
 *
 * @param tx - Drizzle transaction or database instance
 * @param entries - Array of audit entries to insert
 */
export async function logAuditEntries(
  tx: DbOrTx,
  entries: AuditEntry[]
): Promise<void> {
  if (entries.length === 0) return;

  await tx.insert(tablebaseAuditLog).values(
    entries.map((e) => ({
      recordType: e.recordType,
      recordId: e.recordId,
      operation: e.operation,
      oldData: e.oldData ?? null,
      newData: e.newData,
      sourceUrl: e.sourceUrl ?? null,
      verdict: e.verdict ?? null,
      evidence: e.evidence ?? null,
      agentSessionId: e.agentSessionId ?? null,
      prNumber: e.prNumber ?? null,
    }))
  );
}
