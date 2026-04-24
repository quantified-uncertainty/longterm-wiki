/**
 * Audit-context middleware + transaction helper (QUA-442).
 *
 * Two parts:
 *
 * 1. `auditContextMiddleware()` — Hono middleware that reads
 *    `X-Agent-Session-Id` and `X-Agent-Tool` headers and stashes the
 *    values on `c.set('auditContext', ...)`.
 *
 * 2. `applyAuditContext(tx, c)` — call at the top of every transaction
 *    callback. Runs `SET LOCAL app.agent_session_id = ... / app.agent_tool
 *    = ...` so the universal audit trigger (migration 0204) captures
 *    session + tool attribution for every row written in the transaction.
 *
 * The sync-factory wires this automatically; hand-rolled routes need an
 * explicit call. See `.claude/rules/audit-log.md`.
 */

import type { Context, MiddlewareHandler } from "hono";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type * as schema from "../schema.js";

export interface AuditContext {
  sessionId: string | null;
  tool: string | null;
}

// Header name constants shipped to the crux client so both sides stay in sync.
export const AUDIT_SESSION_HEADER = "x-agent-session-id";
export const AUDIT_TOOL_HEADER = "x-agent-tool";

// Loose upper bound to keep a malicious or truncated client from filling
// the audit log with giant GUC strings. Real session IDs are short numeric
// strings and tool names are short slugs; 256 chars is ample.
const MAX_ATTR_LEN = 256;

function sanitizeAttr(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_ATTR_LEN) return trimmed.slice(0, MAX_ATTR_LEN);
  return trimmed;
}

export function auditContextMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const ctx: AuditContext = {
      sessionId: sanitizeAttr(c.req.header(AUDIT_SESSION_HEADER)),
      tool: sanitizeAttr(c.req.header(AUDIT_TOOL_HEADER)),
    };
    c.set("auditContext", ctx);
    await next();
  };
}

export function getAuditContext(c: Context): AuditContext {
  const ctx = c.get("auditContext") as AuditContext | undefined;
  return ctx ?? { sessionId: null, tool: null };
}

type DrizzleTx = PgTransaction<
  PostgresJsQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/**
 * Apply the request's audit context to the current Drizzle transaction.
 *
 * `SET LOCAL` is scoped to the transaction — values reset on COMMIT/ROLLBACK,
 * so no leakage between requests sharing a pooled connection.
 *
 * `set_config(..., true)` is used instead of a bare `SET LOCAL` because
 * Drizzle's `tx.execute(sql...)` is a single parametrized statement; the
 * builtin `set_config(name, value, is_local)` function accepts parameterized
 * values, whereas `SET LOCAL` requires literal identifiers / string
 * constants and would force unsafe string concatenation.
 *
 * Null-or-empty attribution is written as empty strings; the trigger
 * function treats '' as NULL so recording still works and `IS NULL`
 * filters behave predictably.
 */
export async function applyAuditContext(
  tx: DrizzleTx,
  c: Context,
): Promise<void> {
  const ctx = getAuditContext(c);
  // Two calls instead of one; Postgres doesn't have a set_many primitive and
  // merging into a single SELECT is no cheaper.
  await tx.execute(
    sql`SELECT set_config('app.agent_session_id', ${ctx.sessionId ?? ""}, true)`,
  );
  await tx.execute(
    sql`SELECT set_config('app.agent_tool', ${ctx.tool ?? ""}, true)`,
  );
}

/**
 * Convenience for non-Hono callers (background jobs, tests) that want to
 * seed the audit attribution without a Context object.
 */
export async function setAuditContextRaw(
  tx: DrizzleTx,
  ctx: AuditContext,
): Promise<void> {
  await tx.execute(
    sql`SELECT set_config('app.agent_session_id', ${ctx.sessionId ?? ""}, true)`,
  );
  await tx.execute(
    sql`SELECT set_config('app.agent_tool', ${ctx.tool ?? ""}, true)`,
  );
}
