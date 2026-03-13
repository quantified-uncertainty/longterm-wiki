import { eq, or } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { entities } from "../schema.js";

/**
 * Resolve an entity identifier (stableId, slug, or numericId) to a stableId.
 * Returns null if the entity is not found.
 */
export async function resolveEntityStableId(
  db: ReturnType<typeof getDrizzleDb>,
  identifier: string,
): Promise<string | null> {
  const rows = await db
    .select({ stableId: entities.stableId })
    .from(entities)
    .where(
      or(
        eq(entities.stableId, identifier),
        eq(entities.id, identifier),
        eq(entities.numericId, identifier),
      )
    )
    .limit(1);
  return rows[0]?.stableId ?? null;
}
