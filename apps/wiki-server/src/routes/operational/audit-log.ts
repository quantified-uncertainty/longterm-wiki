/**
 * Universal audit log API (QUA-442).
 *
 * Reads from the `full_audit_log` table (populated by the `audit_trigger_fn()`
 * PL/pgSQL trigger). Filters by table, session, txn_id, and time window.
 * Complements the existing `tablebase_audit_log` (which lives at
 * `/api/tablebase/audit-log` if and when we ship a route for it).
 */

import { Hono } from "hono";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { fullAuditLog } from "../../schema.js";
import { zv, clampedLimit } from "../shared/utils.js";
import { z } from "zod";

// Schema accepts the primary filter axes. Callers should pass at least one
// of `table`, `session`, or `txn` — passing none returns recent writes
// across all tables, which is useful for ops dashboards but clamped hard.
const ListQuery = z.object({
  table: z.string().trim().min(1).max(128).optional(),
  session: z.string().trim().min(1).max(256).optional(),
  // bigint serialized as string to avoid JSON-number precision loss.
  txn: z
    .string()
    .trim()
    .regex(/^\d+$/)
    .optional(),
  since: z.string().datetime({ offset: true }).optional(),
  limit: clampedLimit(500, 50),
});

const auditLogApp = new Hono().get(
  "/recent",
  zv("query", ListQuery),
  async (c) => {
    const db = getDrizzleDb();
    const q = c.req.valid("query");

    const conditions = [];
    if (q.table) {
      conditions.push(eq(fullAuditLog.tableName, q.table));
    }
    if (q.session) {
      conditions.push(eq(fullAuditLog.sessionId, q.session));
    }
    if (q.txn) {
      // Drizzle's bigint column expects a bigint-typed value.
      conditions.push(eq(fullAuditLog.txnId, BigInt(q.txn)));
    }
    if (q.since) {
      conditions.push(gte(fullAuditLog.changedAt, new Date(q.since)));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Serialize bigints as strings in the wire format. Drizzle returns
    // `id` / `txnId` as JS bigints (see schema.ts: mode: "bigint"), and
    // JSON.stringify would throw.
    const rows = await db
      .select({
        id: sql<string>`${fullAuditLog.id}::text`,
        tableName: fullAuditLog.tableName,
        operation: fullAuditLog.operation,
        oldRow: fullAuditLog.oldRow,
        newRow: fullAuditLog.newRow,
        txnId: sql<string | null>`${fullAuditLog.txnId}::text`,
        sessionId: fullAuditLog.sessionId,
        tool: fullAuditLog.tool,
        applicationName: fullAuditLog.applicationName,
        changedAt: fullAuditLog.changedAt,
      })
      .from(fullAuditLog)
      .where(whereClause)
      .orderBy(desc(fullAuditLog.changedAt))
      .limit(q.limit);

    return c.json({ entries: rows });
  },
);

export const auditLogRoute = auditLogApp;
export type AuditLogRoute = typeof auditLogApp;
