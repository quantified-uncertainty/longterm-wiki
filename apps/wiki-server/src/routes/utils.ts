import type { Context } from "hono";

/** Safely parse JSON body, returning null on parse failure. */
export function parseJsonBody(c: Context) {
  return c.req.json().catch(() => null);
}

/** Return a 400 validation error response. */
export function validationError(c: Context, message: string) {
  return c.json({ error: "validation_error", message }, 400);
}

/** Return a 400 invalid JSON error response. */
export function invalidJsonError(c: Context) {
  return c.json(
    { error: "invalid_json", message: "Request body must be valid JSON" },
    400
  );
}

/** Return a 404 not found error response. */
export function notFoundError(c: Context, message: string) {
  return c.json({ error: "not_found", message }, 404);
}
