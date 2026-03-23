/**
 * Hono middleware that auto-resolves :entityId path params from slugs to stableIds.
 *
 * Usage:
 *   const app = new Hono<{ Variables: ResolvedEntityVars }>()
 *     .get("/by-entity/:entityId", resolveEntityId(), handler)
 *
 * Handlers read `c.get("resolvedEntityId")` instead of calling resolveEntityStableId manually.
 * New routes automatically get resolution — no one can forget.
 */
import type { MiddlewareHandler } from "hono";
import { getDrizzleDb } from "../../db.js";
import { resolveEntityStableId } from "./query-helpers.js";

/** Hono Variables type for routes that use entity resolution middleware. */
export interface ResolvedEntityVars {
  resolvedEntityId: string;
}

/**
 * Middleware that resolves a path param (slug or stableId) to a stableId
 * and stores it as `c.var.resolvedEntityId`.
 *
 * @param paramName - The path param to resolve (default: "entityId").
 *   Use "holderId", "investorId", etc. for non-standard param names.
 */
export function resolveEntityId(paramName = "entityId"): MiddlewareHandler {
  return async (c, next) => {
    const raw = c.req.param(paramName);
    if (!raw) {
      return c.json({ error: `Missing required path param: ${paramName}` }, 400);
    }
    const db = getDrizzleDb();
    const resolved = await resolveEntityStableId(db, raw);
    if (!resolved) {
      return c.json({ error: `Entity not found: ${raw}` }, 404);
    }
    c.set("resolvedEntityId", resolved);
    await next();
  };
}
