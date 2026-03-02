/**
 * Shared helpers for the wiki_pages integer PK migration (Phase 4a, #1498).
 *
 * Provides functions to resolve page slugs to integer IDs for dual-write
 * and to auto-allocate entity IDs for new pages during sync.
 */

import { eq, inArray, sql } from "drizzle-orm";
import { entityIds } from "../schema.js";
import type { getDrizzleDb } from "../db.js";

type DrizzleDb = ReturnType<typeof getDrizzleDb>;

/**
 * Resolve a single page slug to its integer ID via entity_ids table.
 * Returns null if the slug has no entity_id allocation.
 */
export async function resolvePageIntId(
  db: DrizzleDb,
  slug: string
): Promise<number | null> {
  const rows = await db
    .select({ numericId: entityIds.numericId })
    .from(entityIds)
    .where(eq(entityIds.slug, slug))
    .limit(1);
  return rows[0]?.numericId ?? null;
}

/**
 * Resolve multiple page slugs to their integer IDs in one query.
 * Returns a Map<slug, intId>. Slugs without an entity_id allocation are omitted.
 */
export async function resolvePageIntIds(
  db: DrizzleDb,
  slugs: string[]
): Promise<Map<string, number>> {
  if (slugs.length === 0) return new Map();

  const uniqueSlugs = [...new Set(slugs)];
  const rows = await db
    .select({ slug: entityIds.slug, numericId: entityIds.numericId })
    .from(entityIds)
    .where(inArray(entityIds.slug, uniqueSlugs));

  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.slug, row.numericId);
  }
  return map;
}

/**
 * Auto-allocate entity IDs for slugs that don't have one yet.
 * Uses the entity_id_seq sequence for new IDs.
 * Returns the complete slug→intId mapping (including newly allocated).
 */
export async function allocateAndResolvePageIntIds(
  db: DrizzleDb,
  slugs: string[]
): Promise<Map<string, number>> {
  if (slugs.length === 0) return new Map();

  const uniqueSlugs = [...new Set(slugs)];

  // First, resolve existing
  const existing = await resolvePageIntIds(db, uniqueSlugs);

  // Find missing slugs
  const missing = uniqueSlugs.filter((s) => !existing.has(s));

  if (missing.length > 0) {
    // Bulk-allocate all missing slugs in one INSERT.
    // ON CONFLICT DO NOTHING handles concurrent inserts; RETURNING gives us the new rows.
    const inserted = await db
      .insert(entityIds)
      .values(
        missing.map((slug) => ({
          numericId: sql`nextval('entity_id_seq')`.mapWith(Number),
          slug,
        }))
      )
      .onConflictDoNothing({ target: entityIds.slug })
      .returning({ numericId: entityIds.numericId, slug: entityIds.slug });

    for (const row of inserted) {
      existing.set(row.slug, row.numericId);
    }

    // Re-fetch any slugs that hit a conflict (inserted concurrently).
    // These won't be in `inserted` because ON CONFLICT DO NOTHING skips RETURNING.
    const stillMissing = missing.filter((s) => !existing.has(s));
    if (stillMissing.length > 0) {
      const refetched = await db
        .select({ slug: entityIds.slug, numericId: entityIds.numericId })
        .from(entityIds)
        .where(inArray(entityIds.slug, stillMissing));
      for (const row of refetched) {
        existing.set(row.slug, row.numericId);
      }
    }
  }

  // Fail-fast if any slugs remain unresolved after allocation + re-fetch.
  const unresolved = uniqueSlugs.filter((s) => !existing.has(s));
  if (unresolved.length > 0) {
    throw new Error(
      `Failed to resolve integer IDs for ${unresolved.length} slug(s): ${unresolved.slice(0, 5).join(", ")}`
    );
  }

  return existing;
}
