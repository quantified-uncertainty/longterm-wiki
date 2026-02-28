import type { Context } from "hono";
import { z } from "zod";
import { logger as rootLogger } from "../logger.js";

const logger = rootLogger.child({ component: "db" });

/**
 * Create a PaginationQuery schema with configurable limits.
 * Each route can call this with its own defaults while sharing the base shape.
 */
export function paginationQuery(opts?: {
  maxLimit?: number;
  defaultLimit?: number;
}) {
  const { maxLimit = 200, defaultLimit = 50 } = opts ?? {};
  return z.object({
    limit: z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit),
    offset: z.coerce.number().int().min(0).default(0),
  });
}

/** Standard error codes for 400 responses. */
export const VALIDATION_ERROR = "validation_error" as const;
export const INVALID_JSON_ERROR = "invalid_json" as const;

/** Safely parse JSON body, returning null on parse failure. */
export function parseJsonBody(c: Context) {
  return c.req.json().catch(() => null);
}

/** Return a 400 validation error response. */
export function validationError(c: Context, message: string) {
  return c.json({ error: VALIDATION_ERROR, message }, 400);
}

/** Return a 400 invalid JSON error response. */
export function invalidJsonError(c: Context) {
  return c.json(
    { error: INVALID_JSON_ERROR, message: "Request body must be valid JSON" },
    400
  );
}

/** Return a 404 not found error response. */
export function notFoundError(c: Context, message: string) {
  return c.json({ error: "not_found", message }, 404);
}

/** Return a 500 database error response, logging the underlying error. */
export function dbError(
  c: Context,
  operation: string,
  err: unknown,
  context?: Record<string, unknown>
) {
  logger.error({
    operation,
    ...(context ?? {}),
    err: err instanceof Error ? err.message : String(err),
  }, `${operation} failed`);
  return c.json({ error: "database_error", message: `${operation} failed` }, 500);
}

/** Extract the first row from a query result, throwing if empty. */
export function firstOrThrow<T>(rows: T[], context: string): T {
  if (rows.length === 0) {
    throw new Error(`Expected at least one row (${context})`);
  }
  return rows[0];
}
