/**
 * Shared audit logging utility for TableBase changes.
 *
 * Any sync handler can call `logAuditEntries(tx, entries)` inside its
 * transaction to record inserts/updates/deletes to the audit log.
 */

import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { sql } from "drizzle-orm";
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

  // QUA-442: if the caller didn't pass an agent_session_id but the
  // request set one via `SET LOCAL app.agent_session_id` (middleware +
  // applyAuditContext), pull it from the GUC so the existing rich
  // audit log gets session attribution too. Runs once per call, not
  // per-row. Empty / unset GUC comes back as an empty string; treat
  // that as NULL.
  let gucSession: string | null = null;
  try {
    const [row] = (await tx.execute(
      sql`SELECT current_setting('app.agent_session_id', true) AS session_id`,
    )) as unknown as Array<{ session_id: string | null }>;
    const raw = row?.session_id ?? null;
    gucSession = raw && raw.length > 0 ? raw : null;
  } catch {
    // Fail-open: audit attribution is best-effort. If this tx doesn't support
    // current_setting for any reason, fall back to NULL.
    gucSession = null;
  }

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
      agentSessionId: e.agentSessionId ?? gucSession,
      prNumber: e.prNumber ?? null,
    }))
  );
}
