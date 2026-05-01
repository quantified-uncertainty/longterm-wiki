import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Context } from "hono";
import { validationError } from "./utils.js";
import { logger as rootLogger } from "../../logger.js";

/**
 * Exported for tests so they can `vi.spyOn(skipLogger, "warn"|"error")` to
 * assert on bypass-logging behavior. Production callers should not import this.
 */
export const skipLogger = rootLogger.child({ component: "validate-entity-refs" });

/**
 * Describes a foreign-key reference field to validate against the entities table.
 * `fieldName` is the human-readable name for error messages.
 * `ids` is the list of entity identifiers to check.
 */
export interface EntityRefField {
  fieldName: string;
  ids: string[];
}

/**
 * Batch-check that all entity IDs in the given fields exist in the entities table.
 * Checks BOTH `entities.id` (slug) and `entities.stable_id` to handle both formats.
 *
 * Returns the subset of IDs per field that do NOT exist (i.e. dangling references).
 * Returns an empty array if all references are valid.
 */
export async function findMissingEntityRefs(
  db: PostgresJsDatabase<Record<string, unknown>>,
  fields: EntityRefField[],
): Promise<Array<{ fieldName: string; missingIds: string[] }>> {
  // Collect all unique IDs across all fields
  const allIds = [...new Set(fields.flatMap((f) => f.ids).filter(Boolean))];
  if (allIds.length === 0) return [];

  // Single query: find all IDs that match either entities.id or entities.stable_id
  const placeholders = allIds.map((id) => sql`${id}`);
  const inList = sql.join(placeholders, sql`, `);

  const rows = await db.execute<{ ref: string }>(sql`
    SELECT unnest AS ref
    FROM unnest(ARRAY[${inList}]::text[]) AS unnest
    WHERE unnest IN (SELECT id FROM entities)
       OR unnest IN (SELECT stable_id FROM entities)
  `);

  const found = new Set(rows.map((r) => r.ref));

  // Check each field for missing IDs
  const results: Array<{ fieldName: string; missingIds: string[] }> = [];
  for (const field of fields) {
    const missing = [...new Set(field.ids)].filter((id) => id && !found.has(id));
    if (missing.length > 0) {
      results.push({ fieldName: field.fieldName, missingIds: missing });
    }
  }

  return results;
}

/**
 * Check if the request asked to skip entity validation, and log loudly when it
 * does. Returns true if validation should be skipped, false otherwise.
 *
 * Per epic #4017 Phase A, the `skipEntityValidation` bypass must be loud AND
 * justified — both halves of the contract. The caller passes a
 * `skipEntityValidationReason` query param explaining why:
 *
 *   - Reason present: log at warn level, return true (bypass allowed).
 *   - Reason missing or whitespace-only: log at error level AND return false
 *     (bypass DENIED — caller falls through to normal FK validation, which
 *     will return 400 if any refs are missing). PR #4023 review hardening.
 *
 * Exported for use by routes (grants.ts, benchmark-results.ts) that have their
 * own custom validation logic and don't go through `validateEntityRefs()`.
 */
export function shouldSkipEntityValidation(c: Context): boolean {
  const skip = c.req.query("skipEntityValidation");
  if (skip !== "true") return false;

  const reason = c.req.query("skipEntityValidationReason")?.trim();
  const ctx = { path: c.req.path, method: c.req.method } as const;
  if (!reason) {
    skipLogger.error(
      // Include the raw reason value (whether undefined or whitespace) so
      // operators can distinguish "no param sent" from "param was blank".
      { ...ctx, rawReason: c.req.query("skipEntityValidationReason") ?? null },
      // skipEntityValidation-ok: error message text mentions the bypass keyword
      "skipEntityValidation=true called without skipEntityValidationReason — bypass DENIED. Pass &skipEntityValidationReason=<why> in the query string (issue #4017).",
    );
    return false;
  }

  skipLogger.warn({ ...ctx, reason }, "Entity FK validation skipped");
  return true;
}

/**
 * Validate entity FK references and return a 400 error response if any are missing.
 * Returns null if all references are valid (caller should proceed).
 *
 * Skipped if `skipEntityValidation` query param is "true" (for migration/backfill
 * scenarios). The bypass is logged loudly via {@link shouldSkipEntityValidation}.
 */
export async function validateEntityRefs(
  c: Context,
  db: PostgresJsDatabase<Record<string, unknown>>,
  fields: EntityRefField[],
): Promise<Response | null> {
  // Allow skipping validation for migration/backfill scenarios
  if (shouldSkipEntityValidation(c)) return null;

  const missing = await findMissingEntityRefs(db, fields);
  if (missing.length === 0) return null;

  const details = missing
    .map((m) => `${m.fieldName}: ${m.missingIds.join(", ")}`)
    .join("; ");

  // QUA-952 (Phase 0a-ii): emit structured `code: "fk_missing"` so callers
  // can dispatch retry-with-feedback by FK class. The first missing field
  // populates the structured `field`/`value` slots; the full multi-field
  // summary stays in `message` for human-readable detail and to preserve
  // back-compat with existing 1-arg-style string-matching consumers.
  //
  // The bypass instruction is intentionally repeated in `message` (not just
  // logged) so an operator pasting a 400 response into a chat can read the
  // bypass syntax without server-log access. The QUA-940 deny-message
  // contract proper lives in the `error`-level log inside
  // `shouldSkipEntityValidation` — this body string just mirrors the
  // operator-facing hint.
  //
  // `value` caps at FK_MISSING_VALUE_CAP IDs to keep 400 responses bounded
  // when a 500-item batch has every reference invalid. The full list still
  // appears in `message` for now; a structured-only consumer will need to
  // page over `field` if it has more than CAP missing IDs (Phase 3 retry
  // re-prompts on one item at a time anyway).
  const first = missing[0];
  const value =
    first.missingIds.length > FK_MISSING_VALUE_CAP
      ? first.missingIds.slice(0, FK_MISSING_VALUE_CAP)
      : first.missingIds;
  return validationError(c, {
    code: "fk_missing",
    field: first.fieldName,
    value,
    // skipEntityValidation-ok: error message text instructs callers how to bypass after providing a reason
    message: `Entity references not found: ${details}. Use ?skipEntityValidation=true&skipEntityValidationReason=<why> to bypass.`,
  });
}

/**
 * Cap the size of the `value` array in fk_missing 400 responses. A 500-item
 * batch with every reference invalid would otherwise serialize 500 IDs into
 * `value` AND into the human-readable `message` (which already enumerates
 * all of them), producing 10–50KB+ 400 responses. The full list is still
 * available in `message`; this cap protects only the structured `value`.
 */
const FK_MISSING_VALUE_CAP = 50;
