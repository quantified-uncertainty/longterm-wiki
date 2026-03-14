import { Hono } from "hono";
import { z } from "zod";
import {
  eq,
  and,
  count,
  desc,
  asc,
  sql,
  ilike,
  or,
  isNull,
  isNotNull,
} from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { things, VALID_THING_TYPES } from "../schema.js";
import {
  zv,
  validationError,
  parseJsonBody,
  invalidJsonError,
  escapeIlike,
} from "./utils.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;
const MAX_SYNC_BATCH = 200;

// ---- Query schemas ----

const ListQuery = z.object({
  thing_type: z.string().max(50).optional(),
  entity_type: z.string().max(100).optional(),
  parent_id: z.string().max(100).optional(),
  verdict: z.string().max(50).optional(),
  has_verdict: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  sort: z.enum(["title", "updated_at", "created_at", "thing_type"]).default("title"),
  order: z.enum(["asc", "desc"]).default("asc"),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const SearchQuery = z.object({
  q: z.string().min(1).max(500),
  thing_type: z.string().max(50).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const StatsQuery = z.object({
  parent_id: z.string().max(100).optional(),
});

// ---- Helpers ----

function formatThing(t: typeof things.$inferSelect) {
  return {
    id: t.id,
    thingType: t.thingType,
    title: t.title,
    parentThingId: t.parentThingId,
    sourceTable: t.sourceTable,
    sourceId: t.sourceId,
    entityType: t.entityType,
    description: t.description,
    sourceUrl: t.sourceUrl,
    numericId: t.numericId,
    verdict: t.verdict,
    verdictConfidence: t.verdictConfidence,
    verdictAt: t.verdictAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    syncedAt: t.syncedAt,
  };
}

const sortColumns = {
  title: things.title,
  updated_at: things.updatedAt,
  created_at: things.createdAt,
  thing_type: things.thingType,
} as const;

// ---- Route definition (method-chained for Hono RPC type inference) ----

const thingsApp = new Hono()

  // ---- GET /search?q=...&thing_type=...&limit=20 ----
  .get("/search", zv("query", SearchQuery), async (c) => {
    const { q, thing_type, limit } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [];

    // Use full-text search if available, fall back to ILIKE
    conditions.push(
      sql`${things}.search_vector @@ plainto_tsquery('english', ${q})`
    );

    if (thing_type) {
      conditions.push(eq(things.thingType, thing_type));
    }

    const rows = await db
      .select()
      .from(things)
      .where(and(...conditions))
      .orderBy(
        sql`ts_rank(${things}.search_vector, plainto_tsquery('english', ${q})) DESC`
      )
      .limit(limit);

    // Fall back to ILIKE if FTS returned nothing
    if (rows.length === 0) {
      const pattern = `%${escapeIlike(q)}%`;
      const ilikeConditions = [
        or(
          ilike(things.title, pattern),
          ilike(things.id, pattern),
          ilike(things.description, pattern)
        ),
      ];
      if (thing_type) {
        ilikeConditions.push(eq(things.thingType, thing_type));
      }

      const fallbackRows = await db
        .select()
        .from(things)
        .where(and(...ilikeConditions))
        .orderBy(things.title)
        .limit(limit);

      return c.json({
        results: fallbackRows.map(formatThing),
        query: q,
        total: fallbackRows.length,
        searchMethod: "ilike" as const,
      });
    }

    return c.json({
      results: rows.map(formatThing),
      query: q,
      total: rows.length,
      searchMethod: "fts" as const,
    });
  })

  // ---- GET /stats ----
  .get("/stats", zv("query", StatsQuery), async (c) => {
    const { parent_id } = c.req.valid("query");
    const db = getDrizzleDb();

    const baseCondition = parent_id
      ? eq(things.parentThingId, parent_id)
      : undefined;

    const totalResult = await db
      .select({ count: count() })
      .from(things)
      .where(baseCondition);
    const total = totalResult[0].count;

    const byTypeRows = await db
      .select({
        thingType: things.thingType,
        count: count(),
      })
      .from(things)
      .where(baseCondition)
      .groupBy(things.thingType)
      .orderBy(sql`count(*) DESC`);

    const byType: Record<string, number> = {};
    for (const row of byTypeRows) {
      byType[row.thingType] = row.count;
    }

    const byVerdictRows = await db
      .select({
        verdict: sql<string>`COALESCE(${things.verdict}, 'unverified')`,
        count: count(),
      })
      .from(things)
      .where(baseCondition)
      .groupBy(sql`COALESCE(${things.verdict}, 'unverified')`);

    const byVerdict: Record<string, number> = {};
    for (const row of byVerdictRows) {
      byVerdict[row.verdict] = row.count;
    }

    // Count things with entity_type breakdown (entities only)
    const byEntityTypeRows = await db
      .select({
        entityType: things.entityType,
        count: count(),
      })
      .from(things)
      .where(
        baseCondition
          ? and(baseCondition, isNotNull(things.entityType))
          : isNotNull(things.entityType)
      )
      .groupBy(things.entityType)
      .orderBy(sql`count(*) DESC`);

    const byEntityType: Record<string, number> = {};
    for (const row of byEntityTypeRows) {
      if (row.entityType) byEntityType[row.entityType] = row.count;
    }

    return c.json({
      total,
      byType,
      byVerdict,
      byEntityType,
    });
  })

  // ---- GET /children/:parentId ----
  .get("/children/:parentId", zv("query", ListQuery), async (c) => {
    const parentId = c.req.param("parentId");
    const { thing_type, sort, order, limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [eq(things.parentThingId, parentId)];
    if (thing_type) conditions.push(eq(things.thingType, thing_type));

    const whereClause = and(...conditions);

    const sortCol = sortColumns[sort];
    const orderFn = order === "desc" ? desc(sortCol) : asc(sortCol);

    const rows = await db
      .select()
      .from(things)
      .where(whereClause)
      .orderBy(orderFn)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(things)
      .where(whereClause);

    return c.json({
      things: rows.map(formatThing),
      total: countResult[0].count,
      parentId,
    });
  })

  // ---- GET /:id ----
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const db = getDrizzleDb();

    // Look up by thing ID only (primary key) — sourceId lookup was
    // nondeterministic since multiple things can share the same sourceId
    // across different sourceTables.
    const rows = await db
      .select()
      .from(things)
      .where(eq(things.id, id))
      .limit(1);

    if (rows.length === 0) {
      return c.json(
        { error: "not_found", message: `Thing not found: ${id}` },
        404
      );
    }

    const thing = rows[0];

    // Also fetch children count
    const childrenResult = await db
      .select({ count: count() })
      .from(things)
      .where(eq(things.parentThingId, thing.id));

    // Fetch children summary by type
    const childTypeRows = await db
      .select({
        thingType: things.thingType,
        count: count(),
      })
      .from(things)
      .where(eq(things.parentThingId, thing.id))
      .groupBy(things.thingType);

    const childrenByType: Record<string, number> = {};
    for (const row of childTypeRows) {
      childrenByType[row.thingType] = row.count;
    }

    return c.json({
      ...formatThing(thing),
      childrenCount: childrenResult[0].count,
      childrenByType,
    });
  })

  // ---- GET / (paginated listing) ----
  .get("/", zv("query", ListQuery), async (c) => {
    const {
      thing_type,
      entity_type,
      parent_id,
      verdict,
      has_verdict,
      sort,
      order,
      limit,
      offset,
    } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [];
    if (thing_type) conditions.push(eq(things.thingType, thing_type));
    if (entity_type) conditions.push(eq(things.entityType, entity_type));
    if (parent_id) conditions.push(eq(things.parentThingId, parent_id));
    if (verdict) conditions.push(eq(things.verdict, verdict));
    if (has_verdict === true) conditions.push(isNotNull(things.verdict));
    if (has_verdict === false) conditions.push(isNull(things.verdict));

    const whereClause =
      conditions.length > 0 ? and(...conditions) : undefined;

    const sortCol = sortColumns[sort];
    const orderFn = order === "desc" ? desc(sortCol) : asc(sortCol);

    const rows = await db
      .select()
      .from(things)
      .where(whereClause)
      .orderBy(orderFn)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(things)
      .where(whereClause);

    return c.json({
      things: rows.map(formatThing),
      total: countResult[0].count,
      limit,
      offset,
    });
  })

  // ---- POST /sync ----
  .post("/sync", async (c) => {
    const raw = await parseJsonBody(c);
    if (!raw) return invalidJsonError(c);

    const SyncThingSchema = z.object({
      id: z.string().min(1).max(200),
      thingType: z.enum(VALID_THING_TYPES as unknown as [string, ...string[]]),
      title: z.string().min(1).max(2000),
      parentThingId: z.string().max(200).optional(),
      sourceTable: z.string().min(1).max(100),
      sourceId: z.string().min(1).max(200),
      entityType: z.string().max(100).optional(),
      description: z.string().max(10000).optional(),
      sourceUrl: z.string().max(2048).optional(),
      numericId: z.string().max(20).optional(),
    });

    const SyncBatchSchema = z.object({
      things: z.array(SyncThingSchema).min(1).max(MAX_SYNC_BATCH),
    });

    const parsed = SyncBatchSchema.safeParse(raw);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const items = parsed.data.things;

    const db = getDrizzleDb();
    let upserted = 0;

    await db.transaction(async (tx) => {
      const allVals = items.map((item) => ({
        id: item.id,
        thingType: item.thingType,
        title: item.title,
        parentThingId: item.parentThingId ?? null,
        sourceTable: item.sourceTable,
        sourceId: item.sourceId,
        entityType: item.entityType ?? null,
        description: item.description ?? null,
        sourceUrl: item.sourceUrl ?? null,
        numericId: item.numericId ?? null,
      }));

      await tx
        .insert(things)
        .values(allVals)
        .onConflictDoUpdate({
          target: [things.sourceTable, things.sourceId],
          set: {
            id: sql`excluded.id`,
            thingType: sql`excluded.thing_type`,
            title: sql`excluded.title`,
            parentThingId: sql`excluded.parent_thing_id`,
            entityType: sql`excluded.entity_type`,
            description: sql`excluded.description`,
            sourceUrl: sql`excluded.source_url`,
            numericId: sql`excluded.numeric_id`,
            syncedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        });
      upserted = allVals.length;
    });

    return c.json({ upserted });
  });

// ---- Exports ----

export const thingsRoute = thingsApp;
export type ThingsRoute = typeof thingsApp;
