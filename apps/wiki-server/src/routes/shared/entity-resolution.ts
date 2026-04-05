import { eq, or } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { entities } from "../../schema.js";

/**
 * Resolve an entity identifier (stableId, slug, or wikiId) to a stableId.
 * Matching is case-insensitive for slugs (entity IDs are always lowercase).
 * StableIds and wikiIds are matched exactly since they have canonical casing.
 * Returns null if the entity is not found.
 */
export async function resolveEntityStableId(
  db: ReturnType<typeof getDrizzleDb>,
  identifier: string,
): Promise<string | null> {
  const normalizedSlug = identifier.toLowerCase();
  const rows = await db
    .select({ stableId: entities.stableId })
    .from(entities)
    .where(
      or(
        eq(entities.stableId, identifier),
        eq(entities.id, normalizedSlug),
        eq(entities.wikiId, identifier),
      )
    )
    .limit(1);
  return rows[0]?.stableId ?? null;
}
