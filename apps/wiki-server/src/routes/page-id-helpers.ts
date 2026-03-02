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
    // Auto-allocate using raw SQL for nextval
    for (const slug of missing) {
      const rows = await db
        .insert(entityIds)
        .values({
          numericId: sql`nextval('entity_id_seq')`.mapWith(Number),
          slug,
        })
        .onConflictDoNothing({ target: entityIds.slug })
        .returning({ numericId: entityIds.numericId, slug: entityIds.slug });

      if (rows.length > 0) {
        existing.set(rows[0].slug, rows[0].numericId);
      } else {
        // Conflict means it was inserted concurrently — re-fetch
        const refetch = await db
          .select({ numericId: entityIds.numericId })
          .from(entityIds)
          .where(eq(entityIds.slug, slug))
          .limit(1);
        if (refetch.length > 0) {
          existing.set(slug, refetch[0].numericId);
        }
      }
    }
  }

  return existing;
}
