import type { Context } from "hono";
import { validator } from "hono/validator";
import { z } from "zod";
import { logger as rootLogger } from "../../logger.js";

const logger = rootLogger.child({ component: "db" });

/**
 * Create a clamped limit field for pagination schemas.
 * Values above maxLimit are silently clamped (not rejected with 400)
 * so clients requesting larger pages get the maximum allowed.
 *
 * Use this instead of `.max(N)` on limit fields — `.max()` rejects
 * oversized values with a 400 error, which can cause retry storms
 * when clients send large page sizes (see issue #3743).
 */
export function clampedLimit(maxLimit: number, defaultLimit: number) {
  return z.coerce
    .number()
    .int()
    .min(1)
    .default(defaultLimit)
    .transform((v) => Math.min(v, maxLimit));
}

/**
 * Parse a boolean query-string value.
 *
 * Use this instead of `z.coerce.boolean()` for query-string params.
 * `z.coerce.boolean()` runs the value through `Boolean(...)`, so any non-empty
 * string — including the literal `"false"` — coerces to `true`. That means
 * `?flag=false` silently reads as `true`, the opposite of what the caller
 * typed (QUA-651).
 *
 * Accepts only the literal strings `"true"` and `"false"`. Any other value
 * (including `"0"`, `"1"`, `"yes"`, `""`) fails validation with a 400, so
 * silently-wrong boolean filters become impossible.
 *
 * Wrap with `.optional()` when the flag is not required:
 *
 *   const Query = z.object({ flagshipOnly: qBool.optional() });
 */
export const qBool = z
  .enum(["true", "false"])
  .transform((v) => v === "true");

/**
 * Create a PaginationQuery schema with configurable limits.
 * Each route can call this with its own defaults while sharing the base shape.
 * Values above maxLimit are clamped (not rejected) so clients requesting larger
 * pages get the maximum allowed rather than a 400 error.
 */
export function paginationQuery(opts?: {
  maxLimit?: number;
  defaultLimit?: number;
}) {
  const { maxLimit = 200, defaultLimit = 50 } = opts ?? {};
  return z.object({
    limit: clampedLimit(maxLimit, defaultLimit),
    offset: z.coerce.number().int().min(0).default(0),
  });
}

/**
 * Zod refine check: rejects arrays with duplicate `id` values.
 * Use with `.refine(noDuplicateIds, { message: "Duplicate id values in items array" })`.
 */
export function noDuplicateIds(items: { id: string }[]) {
  return new Set(items.map((i) => i.id)).size === items.length;
}

/**
 * Apply the "+1 sentinel → slice + flag" truncation pattern to a row set.
 *
 * Callers should `.limit(cap + 1)` the query so the sentinel fires cleanly
 * when rows exceed the cap, then pass the resulting rows here. Returns the
 * capped `items` array plus a `truncated` flag for the response body.
 *
 * Prefer this over hand-rolling the slice-and-flag — multiple sites across
 * the codebase (resource-dedup, integrity, entity-resources, resources,
 * entity-profile) do the same thing.
 */
export function applyTruncation<T>(
  rows: T[],
  cap: number,
): { items: T[]; truncated: boolean } {
  const truncated = rows.length > cap;
  return { items: truncated ? rows.slice(0, cap) : rows, truncated };
}

/** Standard error codes for 400 responses. */
export const VALIDATION_ERROR = "validation_error" as const;
export const INVALID_JSON_ERROR = "invalid_json" as const;

/** Safely parse JSON body, returning null on parse failure. */
export function parseJsonBody(c: Context) {
  return c.req.json().catch((e: unknown) => {
    logger.debug(
      { error: e instanceof Error ? e.message : String(e), path: c.req.path },
      "parseJsonBody: failed to parse request body as JSON"
    );
    return null;
  });
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
  // Extract the deepest error message — Drizzle wraps PG errors in cause chains
  const extractMessage = (e: unknown): string => {
    if (e instanceof Error) {
      if (e.cause) return `${e.message} | cause: ${extractMessage(e.cause)}`;
      return e.message;
    }
    return String(e);
  };
  const detail = extractMessage(err);
  logger.error({
    operation,
    ...(context ?? {}),
    err: detail,
    stack: err instanceof Error ? err.stack : undefined,
  }, `${operation} failed`);
  return c.json({ error: "database_error", message: `${operation} failed`, detail: detail || "no-error-detail-extracted" }, 500);
}

/** Extract the first row from a query result, throwing if empty. */
export function firstOrThrow<T>(rows: T[], context: string): T {
  if (rows.length === 0) {
    throw new Error(`Expected at least one row (${context})`);
  }
  return rows[0];
}

/** Escape SQL ILIKE/LIKE wildcard metacharacters: %, _, and \ */
export function escapeIlike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

/**
 * Parse a value that may be a scalar number, a JSON array range [low, high],
 * or a plain numeric string into { low, high } numeric bounds.
 *
 * - Plain number (42 or "42") → { low: "42", high: "42" }
 * - JSON array string "[0.07, 0.15]" → { low: "0.07", high: "0.15" }
 * - Array [0.07, 0.15] → { low: "0.07", high: "0.15" }
 * - null/undefined/unparseable → { low: null, high: null }
 *
 * Returns strings suitable for NUMERIC column insertion via Drizzle.
 */
export function parseRange(value: unknown): { low: string | null; high: string | null } {
  if (value == null) return { low: null, high: null };
  if (typeof value === "string" && value.trim() === "") return { low: null, high: null };

  // Already an array (e.g., from JSON parse)
  if (Array.isArray(value) && value.length === 2) {
    const lo = Number(value[0]);
    const hi = Number(value[1]);
    if (!isNaN(lo) && !isNaN(hi)) {
      return { low: String(lo), high: String(hi) };
    }
    return { low: null, high: null };
  }

  // String that looks like a JSON array
  if (typeof value === "string" && value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.length === 2) {
        const lo = Number(parsed[0]);
        const hi = Number(parsed[1]);
        if (!isNaN(lo) && !isNaN(hi)) {
          return { low: String(lo), high: String(hi) };
        }
      }
    } catch {
      // Not valid JSON, fall through
    }
    return { low: null, high: null };
  }

  // Plain number or numeric string
  const n = Number(value);
  if (!isNaN(n)) {
    const s = String(n);
    return { low: s, high: s };
  }

  return { low: null, high: null };
}

/**
 * Zod validator helper for Hono query params or JSON request bodies.
 * Uses Hono's built-in validator to preserve RPC type inference in method-chained routes.
 *
 * - `zv("query", Schema)` — validates URL query string params
 * - `zv("json", Schema)` — validates JSON request body
 */
export function zv<T extends z.ZodType>(target: "query" | "json", schema: T) {
  return validator(target, (value, c) => {
    const result = schema.safeParse(value);
    if (!result.success) {
      return c.json(
        { error: VALIDATION_ERROR, message: result.error.message },
        400
      );
    }
    return result.data as z.infer<T>;
  });
}
