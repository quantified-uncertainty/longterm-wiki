import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, desc } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { entityEvents } from "../../schema.js";
import {
  zv,
  clampedLimit,
} from "../shared/utils.js";
import {
  resolveEntityId,
  type ResolvedEntityVars,
} from "../shared/resolve-entity-middleware.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { paginatedQuery } from "../shared/paginated-query.js";
import { bulkQuery } from "../shared/bulk-query.js";
import { createSyncHandler } from "./sync-factory.js";

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

  // ---- GET /bulk ----
  // Returns every entity event in a single response. QUA-1040.
  .get("/bulk", async (c) => {
    const db = getDrizzleDb();
    const { rows: events, total } = await bulkQuery({
      query: db
        .select()
        .from(entityEvents)
        .orderBy(desc(entityEvents.date), entityEvents.id),
      routeName: "entity-events/bulk",
    });
    return c.json({ events, total });
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

  .post("/sync", createSyncHandler({
    name: "entity-events",
    table: entityEvents,
    syncSchema: SyncItemSchema,
    entityRefs: ["entityId"],
    toThing: (item) => ({
      id: item.id,
      thingType: "entity-event" as const,
      sourceTable: "entity_events",
      sourceId: item.id,
      parentThingId: item.entityId,
      sourceUrl: item.source ?? null,
    }),
  }))

  .post("/delete-batch", deleteBatchHandler(entityEvents, "entity_events"));

export const entityEventsRoute = entityEventsApp;
export type EntityEventsRoute = typeof entityEventsApp;
