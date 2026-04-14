/**
 * Shared helper for upserting things from domain sync handlers.
 *
 * Domain routes call `upsertThingsInTx(tx, items)` inside their existing
 * transaction to keep the things table in sync without duplicating upsert logic.
 */

import { sql, inArray, notInArray, and, eq, or } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type * as schema from "../../schema.js";
import { things, entities } from "../../schema.js";
import { logger as rootLogger } from "../../logger.js";

const logger = rootLogger.child({ module: "thing-sync" });

// ── Raw-ID leak sentinel ────────────────────────────────────────────
//
// Catches sync handlers that bake raw FactBase/stableId identifiers into
// things.title or things.description, which then surface as visible text
// on user-facing data pages (EntityProfileViewer, ClaimsPipelineSummary).
//
// See QUA-397: facts.ts used to fall back to `f.factId` when a label was
// missing, producing titles like "f_mEKUPPFYRg — Google DeepMind".
// This sentinel logs a warning (non-throwing) when any sync handler ships
// a title/description containing a raw-ID-shaped substring, so regressions
// surface in logs and can be caught by an operational validator without
// breaking the sync on first occurrence.
const RAW_ID_RE = /\b(?:f_|sid_)[A-Za-z0-9]{8,}\b/;

/** Exported for unit testing. Returns true if `s` contains a raw FactBase/stableId. */
export function hasRawIdLeak(s: string | null | undefined): boolean {
  return typeof s === "string" && RAW_ID_RE.test(s);
}

type DbOrTx =
  | import("drizzle-orm/postgres-js").PostgresJsDatabase<typeof schema>
  | PgTransaction<
      PostgresJsQueryResultHKT,
      typeof schema,
      ExtractTablesWithRelations<typeof schema>
    >;

// ── Entity title resolution ──────────────────────────────────────────

/**
 * Resolve entity identifiers to their display titles.
 * Accepts both slugs (entities.id, e.g. "open-philanthropy") and stableIds
 * (10-char alphanumeric, e.g. "ULjDXpSLCI"). Used by sync handlers to
 * populate `parentTitle` with human-readable names instead of raw identifiers,
 * so the things search_vector includes org names.
 *
 * Returns a Map<identifier, title> keyed by both slug and stableId for each
 * matched entity. Missing identifiers are omitted (callers should fall back
 * to the raw identifier).
 */
export async function resolveEntityTitles(
  tx: DbOrTx,
  identifiers: string[]
): Promise<Map<string, string>> {
  const unique = [...new Set(identifiers.filter(Boolean))];
  if (unique.length === 0) return new Map();

  const rows = await tx
    .select({ id: entities.id, stableId: entities.stableId, title: entities.title })
    .from(entities)
    .where(or(inArray(entities.id, unique), inArray(entities.stableId, unique)));

  const map = new Map<string, string>();
  for (const r of rows) {
    map.set(r.id, r.title);
    if (r.stableId) map.set(r.stableId, r.title);
  }
  return map;
}

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
 * and rarely changes, keeping the upsert lean.
 */
export async function upsertThingsInTx(
  tx: DbOrTx,
  items: ThingSyncInput[]
): Promise<void> {
  if (items.length === 0) return;

  // Sentinel: warn if any item is about to write a raw-ID-shaped string into
  // a display column. Non-throwing so in-flight syncs with pre-existing bad
  // data still make progress; the warning is the signal for follow-up.
  const leaks: Array<{ sourceTable: string; sourceId: string; field: "title" | "description"; value: string }> = [];
  for (const item of items) {
    if (hasRawIdLeak(item.title)) {
      leaks.push({ sourceTable: item.sourceTable, sourceId: item.sourceId, field: "title", value: item.title });
    }
    if (hasRawIdLeak(item.description)) {
      leaks.push({ sourceTable: item.sourceTable, sourceId: item.sourceId, field: "description", value: item.description ?? "" });
    }
  }
  if (leaks.length > 0) {
    logger.warn(
      {
        leakCount: leaks.length,
        sample: leaks.slice(0, 5),
      },
      `[upsertThingsInTx] raw ID detected in ${leaks.length} thing title/description value(s) — see QUA-397`
    );
  }

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

  // Delete stale things rows that would conflict with the batch.
  // Two conflicts can occur:
  // 1. PK conflict: a thing with the same id exists from a different source
  // 2. Unique index conflict: a thing with the same (source_table, source_id) exists
  //    but with a different id (e.g., entity stableId changed)
  // Delete both types before inserting.
  const batchIds = allVals.map((v) => v.id);
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
        title: sql`excluded.title`,
        thingType: sql`excluded.thing_type`,
        sourceTable: sql`excluded.source_table`,
        sourceId: sql`excluded.source_id`,
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
