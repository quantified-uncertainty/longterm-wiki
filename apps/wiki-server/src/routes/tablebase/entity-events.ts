import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { eq, and, count, desc } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { entityEvents } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
  clampedLimit,
} from "../shared/utils.js";
import {
  resolveEntityId,
  type ResolvedEntityVars,
} from "../shared/resolve-entity-middleware.js";
import {
  upsertThingsInTx,
  resolveEntityTitles,
} from "../shared/thing-sync.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { validateEntityRefs } from "../shared/validate-entity-refs.js";
import { paginatedQuery } from "../shared/paginated-query.js";
import { createSyncHandler } from "./sync-factory.js";
import { useFactoryFor } from "./sync-factory-flag.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

const VALID_EVENT_TYPES = [
  "founding",
  "acquisition",
  "pivot",
  "launch",
  "publication",
  "policy",
  "milestone",
  "leadership-change",
  "incident",
  "funding",
  "dissolution",
  "other",
] as const;

const VALID_SIGNIFICANCE = ["major", "moderate", "minor"] as const;

// ---- Schemas ----

const AllQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 200),
  offset: z.coerce.number().int().min(0).default(0),
});

const ByEntityQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 100),
  offset: z.coerce.number().int().min(0).default(0),
  eventType: z.enum(VALID_EVENT_TYPES).optional(),
});

const SyncItemSchema = z.object({
  id: z.string().length(10),
  entityId: z.string().min(1).max(200),
  entityDisplayName: z.string().max(500).nullable().optional(),
  date: z.string().min(4).max(10), // YYYY, YYYY-MM, or YYYY-MM-DD
  title: z.string().min(1).max(1000),
  description: z.string().max(5000).nullable().optional(),
  eventType: z.enum(VALID_EVENT_TYPES),
  significance: z.enum(VALID_SIGNIFICANCE).nullable().optional(),
  source: z.string().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const SyncBatchSchema = z.object({
  items: z.array(SyncItemSchema).min(1).max(500),
});

// ---- Route ----

const entityEventsApp = new Hono<{ Variables: ResolvedEntityVars }>()

  .get("/stats", async (c) => {
    const db = getDrizzleDb();
    const [statsRow] = await db
      .select({ total: count() })
      .from(entityEvents);
    return c.json({ total: statsRow.total });
  })

  .get("/all", zv("query", AllQuery), async (c) => {
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();
    const { rows: events, total } = await paginatedQuery({
      query: db.select().from(entityEvents)
        .orderBy(desc(entityEvents.date), entityEvents.id)
        .limit(limit).offset(offset),
      countQuery: db.select({ count: count() }).from(entityEvents),
    });
    return c.json({ events, total, limit, offset });
  })

  .get(
    "/by-entity/:entityId",
    resolveEntityId(),
    zv("query", ByEntityQuery),
    async (c) => {
      const resolvedId = c.get("resolvedEntityId");
      const { limit, offset, eventType } = c.req.valid("query");
      const db = getDrizzleDb();
      const conditions = [eq(entityEvents.entityId, resolvedId)];
      if (eventType) conditions.push(eq(entityEvents.eventType, eventType));
      const where = and(...conditions);
      const { rows: events, total } = await paginatedQuery({
        query: db.select().from(entityEvents).where(where)
          .orderBy(desc(entityEvents.date), entityEvents.id)
          .limit(limit).offset(offset),
        countQuery: db.select({ count: count() }).from(entityEvents).where(where),
      });
      return c.json({ entityId: resolvedId, events, total, limit, offset });
    }
  )

  // ---- POST /sync ----
  //
  // Phase 2 Batch C migration (issue #4090, discussion #4088): factory and
  // legacy handlers coexist behind USE_SYNC_FACTORY_ROUTES feature flag.
  // Rollback: set `USE_SYNC_FACTORY_ROUTES=!entity-events` to fall back
  // to the legacy handler instantly without redeploying.
  .post("/sync", async (c) => {
    if (useFactoryFor("entity-events")) {
      return factorySyncHandler(c);
    }
    return legacySyncHandler(c);
  })

  .post("/delete-batch", deleteBatchHandler(entityEvents, "entity_events"));

// ---- Factory implementation (Phase 2 Batch C) ----

const factorySyncHandler = createSyncHandler({
  name: "entity-events",
  table: entityEvents,
  batchSchema: SyncBatchSchema,
  entityRefFields: (items) => [
    { fieldName: "entityId", ids: items.map((i) => i.entityId) },
  ],
  toRow: (item, now) => ({
    id: item.id,
    entityId: item.entityId,
    entityDisplayName: item.entityDisplayName ?? null,
    date: item.date,
    title: item.title,
    description: item.description ?? null,
    eventType: item.eventType,
    significance: item.significance ?? null,
    source: item.source ?? null,
    notes: item.notes ?? null,
    syncedAt: now,
    updatedAt: now,
  }),
  toThing: (item, titleMap) => ({
    id: item.id,
    thingType: "entity-event" as const,
    title: `${item.title} (${item.date})`,
    sourceTable: "entity_events",
    sourceId: item.id,
    parentThingId: item.entityId,
    parentTitle: titleMap.get(item.entityId) ?? item.entityId,
    sourceUrl: item.source ?? null,
    description: item.description ?? null,
  }),
  thingsTitleIds: (items) => [...new Set(items.map((i) => i.entityId))],
});

// ---- Legacy sync handler (kept for 7-day soak window after Phase 2 migration) ----

async function legacySyncHandler(c: Context) {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = SyncBatchSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { items } = parsed.data;
  const db = getDrizzleDb();

  const refError = await validateEntityRefs(c, db, [
    { fieldName: "entityId", ids: items.map((i) => i.entityId) },
  ]);
  if (refError) return refError;

  const now = new Date();
  let upserted = 0;

  await db.transaction(async (tx) => {
    const entityIds = [...new Set(items.map((i) => i.entityId))];
    const titleMap = await resolveEntityTitles(tx, entityIds);

    for (const item of items) {
      await tx
        .insert(entityEvents)
        .values({
          id: item.id,
          entityId: item.entityId,
          entityDisplayName: item.entityDisplayName ?? null,
          date: item.date,
          title: item.title,
          description: item.description ?? null,
          eventType: item.eventType,
          significance: item.significance ?? null,
          source: item.source ?? null,
          notes: item.notes ?? null,
          syncedAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: entityEvents.id,
          set: {
            entityId: item.entityId,
            entityDisplayName: item.entityDisplayName ?? null,
            date: item.date,
            title: item.title,
            description: item.description ?? null,
            eventType: item.eventType,
            significance: item.significance ?? null,
            source: item.source ?? null,
            notes: item.notes ?? null,
            syncedAt: now,
            updatedAt: now,
          },
        });
      upserted++;
    }

    const entityTitle = (id: string) => titleMap.get(id) ?? id;

    await upsertThingsInTx(
      tx,
      items.map((i) => ({
        id: i.id,
        thingType: "entity-event" as const,
        title: `${i.title} (${i.date})`,
        sourceTable: "entity_events",
        sourceId: i.id,
        parentThingId: i.entityId,
        parentTitle: entityTitle(i.entityId),
        sourceUrl: i.source ?? null,
        description: i.description ?? null,
      }))
    );
  });

  return c.json({ upserted });
}

export const entityEventsRoute = entityEventsApp;
export type EntityEventsRoute = typeof entityEventsApp;
