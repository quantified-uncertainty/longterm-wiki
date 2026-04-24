/**
 * Shared helper for upserting things from domain sync handlers.
 *
 * Domain routes call `upsertThingsInTx(tx, items)` inside their existing
 * transaction to keep the things table in sync without duplicating upsert logic.
 *
 * QUA-507 (Phase 4b-B.2c): `things` is now a pointer-only index. The
 * denormalized `title` / `description` / `parent_title` columns have been
 * dropped (migration 0204). Display fields are resolved at read time via
 * the `things_search` materialized view (see migration 0190).
 */

import { sql, inArray, and, eq } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type * as schema from "../../schema.js";
import { things } from "../../schema.js";

type DbOrTx =
  | import("drizzle-orm/postgres-js").PostgresJsDatabase<typeof schema>
  | PgTransaction<
      PostgresJsQueryResultHKT,
      typeof schema,
      ExtractTablesWithRelations<typeof schema>
    >;

// ── href computation (single source of truth for URL patterns) ──────

/** Map entity type to its directory route prefix. */
const ENTITY_TYPE_ROUTE: Record<string, string> = {
  organization: "/organizations",
  person: "/people",
  "ai-model": "/ai-models",
  benchmark: "/benchmarks",
  policy: "/legislation",
  project: "/projects",
  approach: "/approaches",
  event: "/events",
  "research-area": "/research-areas",
};

/** Compute href for an entity based on its type and slug. */
export function entityHref(entityType: string | null | undefined, slug: string, wikiId?: string | null): string {
  const prefix = entityType ? ENTITY_TYPE_ROUTE[entityType] : null;
  if (prefix) return `${prefix}/${slug}`;
  if (wikiId) return `/wiki/${wikiId}`;
  return `/wiki/${slug}`;
}

/**
 * Compute the navigable href for any thing row.
 * This is the SINGLE source of truth for thing → URL mapping.
 * Called at query time (not stored in DB) to avoid staleness.
 */
export function thingHref(t: {
  thingType: string;
  sourceTable: string;
  sourceId: string;
  entityType?: string | null;
  wikiId?: string | null;
  sourceUrl?: string | null;
  parentThingId?: string | null;
}): string | null {
  switch (t.thingType) {
    case "entity":
      return entityHref(t.entityType, t.sourceId, t.wikiId);
    case "grant":
      // parentThingId is the org's stableId — but we need the org slug (sourceId).
      // For grants, the sourceTable is "grants" and we can use the org-scoped route
      // if we have parentThingId. Fall back to the flat grant route.
      return `/grants/${t.sourceId}`;
    case "funding-round":
      return `/funding-rounds/${t.sourceId}`;
    case "funding-program":
      return `/funding-programs/${t.sourceId}`;
    case "division":
      return `/divisions/${t.sourceId}`;
    case "benchmark":
      // wikiId stores the benchmark slug (sourceId is a content hash)
      return `/benchmarks/${t.wikiId || t.sourceId}`;
    case "research-area":
      return `/research-areas/${t.sourceId}`;
    case "resource":
      return t.sourceUrl || null;
    default:
      // Join-table types (investment, equity-position, personnel, etc.)
      // don't have dedicated pages
      return null;
  }
}

// ── Sync types ──────────────────────────────────────────────────────

/**
 * Pointer-only row written to the `things` index. QUA-507 removed the
 * denormalized display fields (title/description/parent_title) — they now
 * live in the `things_search` MV and are computed from source tables.
 */
export interface ThingSyncInput {
  id: string;
  thingType: string;
  sourceTable: string;
  sourceId: string;
  parentThingId?: string | null;
  entityType?: string | null;
  sourceUrl?: string | null;
  wikiId?: string | null;
}

/**
 * Upsert things rows inside an existing transaction.
 * Uses ON CONFLICT (source_table, source_id) DO UPDATE to keep things in sync.
 * Skips parentThingId in the UPDATE set — it's backfilled by migration 0087
 * and rarely changes, keeping the upsert lean.
 */
export async function upsertThingsInTx(
  tx: DbOrTx,
  items: ThingSyncInput[]
): Promise<void> {
  if (items.length === 0) return;

  const allVals = items.map((item) => ({
    id: item.id,
    thingType: item.thingType,
    sourceTable: item.sourceTable,
    sourceId: item.sourceId,
    parentThingId: item.parentThingId ?? null,
    entityType: item.entityType ?? null,
    sourceUrl: item.sourceUrl ?? null,
    wikiId: item.wikiId ?? null,
  }));

  // Delete stale things rows that would conflict with the batch.
  // Two conflicts can occur:
  // 1. PK conflict: a thing with the same id exists from a different source
  // 2. Unique index conflict: a thing with the same (source_table, source_id) exists
  //    but with a different id (e.g., entity stableId changed)
  // Delete both types before inserting.
  const batchSourceIds = allVals.map((v) => v.sourceId);
  const sourceTable = allVals[0]?.sourceTable;

  if (sourceTable) {
    // Delete ALL things with matching (source_table, source_id) — they'll be
    // re-inserted by the upsert below. Simpler than trying to skip rows whose
    // id is already in the batch (edge cases with cross-referenced stableIds).
    await tx
      .delete(things)
      .where(
        and(
          eq(things.sourceTable, sourceTable),
          inArray(things.sourceId, batchSourceIds),
        )
      );
  }

  await tx
    .insert(things)
    .values(allVals)
    .onConflictDoUpdate({
      target: things.id,
      set: {
        thingType: sql`excluded.thing_type`,
        sourceTable: sql`excluded.source_table`,
        sourceId: sql`excluded.source_id`,
        entityType: sql`excluded.entity_type`,
        sourceUrl: sql`excluded.source_url`,
        wikiId: sql`excluded.wiki_id`,
        syncedAt: sql`now()`,
        updatedAt: sql`now()`,
      },
    });
}
