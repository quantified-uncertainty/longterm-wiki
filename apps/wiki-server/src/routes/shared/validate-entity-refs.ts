import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Context } from "hono";
import { validationError } from "./utils.js";
import { logger as rootLogger } from "../../logger.js";

const skipLogger = rootLogger.child({ component: "validate-entity-refs" });

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
 * does. Returns true if validation should be skipped.
 *
 * Per epic #4017 Phase A, the `skipEntityValidation` bypass must be loud and
 * justified. The caller passes a `skipEntityValidationReason` query param
 * explaining why; if missing, we log at error level so the silent-bypass
 * pattern is visible in production logs and can be alerted on.
 *
 * Exported for use by routes (grants.ts, benchmark-results.ts) that have their
 * own custom validation logic and don't go through `validateEntityRefs()`.
 */
export function shouldSkipEntityValidation(c: Context): boolean {
  const skip = c.req.query("skipEntityValidation");
  if (skip !== "true") return false;

  const reason = c.req.query("skipEntityValidationReason");
  const ctx = { path: c.req.path, method: c.req.method } as const;
  if (!reason || reason.trim().length === 0) {
    skipLogger.error(
      ctx,
      // skipEntityValidation-ok: error message text mentions the bypass keyword
      "skipEntityValidation=true called without skipEntityValidationReason — this bypass MUST be justified (issue #4017). Pass &skipEntityValidationReason=<why> in the query string.",
    );
  } else {
    skipLogger.warn(
      { ...ctx, reason },
      "Entity FK validation skipped",
    );
  }
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

  return validationError(
    c,
    // skipEntityValidation-ok: error message text instructs callers how to bypass after providing a reason
    `Entity references not found: ${details}. Use ?skipEntityValidation=true&skipEntityValidationReason=<why> to bypass.`,
  );
}
