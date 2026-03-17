import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Context } from "hono";
import { validationError } from "./utils.js";

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
 * Validate entity FK references and return a 400 error response if any are missing.
 * Returns null if all references are valid (caller should proceed).
 *
 * Skipped if `skipEntityValidation` query param is "true" (for migration/backfill scenarios).
 */
export async function validateEntityRefs(
  c: Context,
  db: PostgresJsDatabase<Record<string, unknown>>,
  fields: EntityRefField[],
): Promise<Response | null> {
  // Allow skipping validation for migration/backfill scenarios
  const skip = c.req.query("skipEntityValidation");
  if (skip === "true") return null;

  const missing = await findMissingEntityRefs(db, fields);
  if (missing.length === 0) return null;

  const details = missing
    .map((m) => `${m.fieldName}: ${m.missingIds.join(", ")}`)
    .join("; ");

  return validationError(
    c,
    `Entity references not found: ${details}. Use ?skipEntityValidation=true to bypass.`,
  );
}
