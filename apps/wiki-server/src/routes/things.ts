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
import { things, thingResourceVerifications, thingVerdicts, VALID_THING_TYPES } from "../schema.js";
import {
  zv,
  validationError,
  parseJsonBody,
  invalidJsonError,
  escapeIlike,
} from "./utils.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 1000;
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

// ---- Verification schemas ----

const VerificationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const PostVerificationSchema = z.object({
  thingId: z.string().min(1).max(200),
  resourceId: z.string().max(200).optional(),
  sourceUrl: z.string().max(2048).optional(),
  fieldName: z.string().max(200).optional(),
  expectedValue: z.string().max(5000).optional(),
  verdict: z.enum(["confirmed", "contradicted", "unverifiable", "outdated", "partial"]),
  confidence: z.number().min(0).max(1).optional(),
  extractedValue: z.string().max(5000).optional(),
  checkerModel: z.string().max(100).optional(),
  isPrimarySource: z.boolean().optional(),
  notes: z.string().max(10000).optional(),
});

const PostVerdictSchema = z.object({
  thingId: z.string().min(1).max(200),
  verdict: z.enum(["confirmed", "contradicted", "unverifiable", "outdated", "partial", "unchecked"]),
  confidence: z.number().min(0).max(1).optional(),
  reasoning: z.string().max(10000).optional(),
  sourcesChecked: z.number().int().min(0).optional(),
  needsRecheck: z.boolean().optional(),
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

function formatVerification(v: typeof thingResourceVerifications.$inferSelect) {
  return {
    id: v.id,
    thingId: v.thingId,
    resourceId: v.resourceId,
    sourceUrl: v.sourceUrl,
    fieldName: v.fieldName,
    expectedValue: v.expectedValue,
    verdict: v.verdict,
    confidence: v.confidence,
    extractedValue: v.extractedValue,
    checkerModel: v.checkerModel,
    isPrimarySource: v.isPrimarySource,
    notes: v.notes,
    checkedAt: v.checkedAt,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

function formatVerdict(v: typeof thingVerdicts.$inferSelect) {
  return {
    thingId: v.thingId,
    verdict: v.verdict,
    confidence: v.confidence,
    reasoning: v.reasoning,
    sourcesChecked: v.sourcesChecked,
    needsRecheck: v.needsRecheck,
    lastComputedAt: v.lastComputedAt,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
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

  // ---- GET /verifications/:thingId ----
  .get("/verifications/:thingId", zv("query", VerificationQuery), async (c) => {
    const thingId = c.req.param("thingId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(thingResourceVerifications)
      .where(eq(thingResourceVerifications.thingId, thingId))
      .orderBy(desc(thingResourceVerifications.checkedAt))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(thingResourceVerifications)
      .where(eq(thingResourceVerifications.thingId, thingId));

    return c.json({
      verifications: rows.map(formatVerification),
      total: countResult[0].count,
      thingId,
    });
  })

  // ---- POST /verifications ----
  .post("/verifications", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = PostVerificationSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const data = parsed.data;
    const db = getDrizzleDb();

    // Verify the thing exists
    const thingRows = await db
      .select({ id: things.id })
      .from(things)
      .where(eq(things.id, data.thingId))
      .limit(1);
    if (thingRows.length === 0) {
      return c.json(
        { error: "not_found", message: `Thing not found: ${data.thingId}` },
        404
      );
    }

    const inserted = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(thingResourceVerifications)
        .values({
          thingId: data.thingId,
          resourceId: data.resourceId ?? null,
          sourceUrl: data.sourceUrl ?? null,
          fieldName: data.fieldName ?? null,
          expectedValue: data.expectedValue ?? null,
          verdict: data.verdict,
          confidence: data.confidence ?? null,
          extractedValue: data.extractedValue ?? null,
          checkerModel: data.checkerModel ?? null,
          isPrimarySource: data.isPrimarySource ?? false,
          notes: data.notes ?? null,
        })
        .returning();

      // Auto-flag the aggregate verdict for recheck
      await tx
        .update(thingVerdicts)
        .set({ needsRecheck: true, updatedAt: new Date() })
        .where(eq(thingVerdicts.thingId, data.thingId));

      return row;
    });

    return c.json(formatVerification(inserted), 201);
  })

  // ---- GET /verdicts/:thingId ----
  .get("/verdicts/:thingId", async (c) => {
    const thingId = c.req.param("thingId");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(thingVerdicts)
      .where(eq(thingVerdicts.thingId, thingId))
      .limit(1);

    if (rows.length === 0) {
      return c.json(
        { error: "not_found", message: `No verdict for thing: ${thingId}` },
        404
      );
    }

    return c.json(formatVerdict(rows[0]));
  })

  // ---- POST /verdicts ----
  .post("/verdicts", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = PostVerdictSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const data = parsed.data;
    const db = getDrizzleDb();

    // Verify the thing exists
    const thingRows = await db
      .select({ id: things.id })
      .from(things)
      .where(eq(things.id, data.thingId))
      .limit(1);
    if (thingRows.length === 0) {
      return c.json(
        { error: "not_found", message: `Thing not found: ${data.thingId}` },
        404
      );
    }

    const now = new Date();

    const upserted = await db.transaction(async (tx) => {
      // Upsert the aggregate verdict
      const [row] = await tx
        .insert(thingVerdicts)
        .values({
          thingId: data.thingId,
          verdict: data.verdict,
          confidence: data.confidence ?? null,
          reasoning: data.reasoning ?? null,
          sourcesChecked: data.sourcesChecked ?? 0,
          needsRecheck: data.needsRecheck ?? false,
          lastComputedAt: now,
        })
        .onConflictDoUpdate({
          target: thingVerdicts.thingId,
          set: {
            verdict: sql`excluded.verdict`,
            confidence: sql`excluded.confidence`,
            reasoning: sql`excluded.reasoning`,
            sourcesChecked: sql`excluded.sources_checked`,
            needsRecheck: sql`excluded.needs_recheck`,
            lastComputedAt: sql`excluded.last_computed_at`,
            updatedAt: sql`now()`,
          },
        })
        .returning();

      // Also update the denormalized verdict on the things row
      await tx
        .update(things)
        .set({
          verdict: data.verdict,
          verdictConfidence: data.confidence ?? null,
          verdictAt: now,
          updatedAt: now,
        })
        .where(eq(things.id, data.thingId));

      return row;
    });

    return c.json(formatVerdict(upserted));
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

    // Reject duplicate (sourceTable, sourceId) within the batch — duplicates
    // would cause the multi-row upsert to fail and roll back.
    const seenSourceKeys = new Set<string>();
    for (const item of items) {
      const key = `${item.sourceTable}\0${item.sourceId}`;
      if (seenSourceKeys.has(key)) {
        return validationError(
          c,
          `Duplicate source key in batch: (${item.sourceTable}, ${item.sourceId})`
        );
      }
      seenSourceKeys.add(key);
    }

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
            // Do NOT update `id` — it's the PK referenced by thing_verdicts
            // and thing_resource_verifications FKs. Changing it would cause
            // constraint violations or cascade-delete verification data.
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
