/**
 * Shared dual-write helper for upserting things from domain sync handlers.
 *
 * Domain routes call `upsertThingsInTx(tx, items)` inside their existing
 * transaction to keep the things table in sync without duplicating upsert logic.
 */

import { sql } from "drizzle-orm";
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
      return `/benchmarks/${t.sourceId}`;
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

export interface ThingSyncInput {
  id: string;
  thingType: string;
  title: string;
  sourceTable: string;
  sourceId: string;
  parentThingId?: string | null;
  entityType?: string | null;
  description?: string | null;
  sourceUrl?: string | null;
  wikiId?: string | null;
  parentTitle?: string | null;
}

/**
 * Upsert things rows inside an existing transaction.
 * Uses ON CONFLICT (source_table, source_id) DO UPDATE to keep things in sync.
 * Skips parentThingId in the UPDATE set — it's backfilled by migration 0087
 * and rarely changes, keeping dual-write lean.
 */
export async function upsertThingsInTx(
  tx: DbOrTx,
  items: ThingSyncInput[]
): Promise<void> {
  if (items.length === 0) return;

  const allVals = items.map((item) => ({
    id: item.id,
    thingType: item.thingType,
    title: item.title,
    sourceTable: item.sourceTable,
    sourceId: item.sourceId,
    parentThingId: item.parentThingId ?? null,
    entityType: item.entityType ?? null,
    description: item.description ?? null,
    sourceUrl: item.sourceUrl ?? null,
    wikiId: item.wikiId ?? null,
    parentTitle: item.parentTitle ?? null,
  }));

  await tx
    .insert(things)
    .values(allVals)
    .onConflictDoUpdate({
      target: [things.sourceTable, things.sourceId],
      set: {
        title: sql`excluded.title`,
        thingType: sql`excluded.thing_type`,
        entityType: sql`excluded.entity_type`,
        description: sql`excluded.description`,
        sourceUrl: sql`excluded.source_url`,
        wikiId: sql`excluded.wiki_id`,
        parentTitle: sql`excluded.parent_title`,
        syncedAt: sql`now()`,
        updatedAt: sql`now()`,
      },
    });
}
