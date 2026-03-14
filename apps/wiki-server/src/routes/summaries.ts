import { Hono } from "hono";
import { z } from "zod";
import { eq, count, sql, desc, asc } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { summaries } from "../schema.js";
import { resolveEntityStableId } from "./entity-resolution.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  notFoundError,
  firstOrThrow,
  paginationQuery,
} from "./utils.js";
import {
  UpsertSummarySchema as SharedUpsertSummarySchema,
  UpsertSummaryBatchSchema,
} from "../api-types.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

// ---- Schemas (from shared api-types) ----

const UpsertSummarySchema = SharedUpsertSummarySchema;
const UpsertBatchSchema = UpsertSummaryBatchSchema;

const PaginationQuery = paginationQuery({ maxLimit: MAX_PAGE_SIZE }).extend({
  entityType: z.string().max(100).optional(),
});

// ---- Helpers ----

type SummaryInput = z.infer<typeof UpsertSummarySchema>;

function summaryValues(d: SummaryInput, resolvedEntityId: string) {
  return {
    entityId: resolvedEntityId,
    entityType: d.entityType,
    oneLiner: d.oneLiner ?? null,
    summary: d.summary ?? null,
    review: d.review ?? null,
    keyPoints: d.keyPoints ?? null,
    keyClaims: d.keyClaims ?? null,
    model: d.model ?? null,
    tokensUsed: d.tokensUsed ?? null,
  };
}

function formatSummary(r: typeof summaries.$inferSelect) {
  return {
    entityId: r.entityId,
    entityType: r.entityType,
    oneLiner: r.oneLiner,
    summary: r.summary,
    review: r.review,
    keyPoints: r.keyPoints,
    keyClaims: r.keyClaims,
    model: r.model,
    tokensUsed: r.tokensUsed,
    generatedAt: r.generatedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ---- Routes ----

const summariesApp = new Hono()
  // ---- POST / (upsert single summary) ----
  .post("/", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = UpsertSummarySchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const db = getDrizzleDb();

    // Resolve entity identifier to stableId
    const stableId = await resolveEntityStableId(db, parsed.data.entityId);
    if (!stableId) {
      return validationError(c, `Referenced entity not found: ${parsed.data.entityId}`);
    }

    const vals = summaryValues(parsed.data, stableId);

    const rows = await db
      .insert(summaries)
      .values(vals)
      .onConflictDoUpdate({
        target: summaries.entityId,
        set: {
          entityType: vals.entityType,
          oneLiner: vals.oneLiner,
          summary: vals.summary,
          review: vals.review,
          keyPoints: vals.keyPoints,
          keyClaims: vals.keyClaims,
          model: vals.model,
          tokensUsed: vals.tokensUsed,
          generatedAt: sql`now()`,
          updatedAt: sql`now()`,
        },
      })
      .returning({
        entityId: summaries.entityId,
        entityType: summaries.entityType,
      });

    return c.json(firstOrThrow(rows, "summary upsert"), 201);
  })

  // ---- POST /batch (upsert multiple summaries) ----
  .post("/batch", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = UpsertBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;
    const db = getDrizzleDb();

    // Resolve all entity identifiers to stableIds
    const uniqueIds = [...new Set(items.map((i) => i.entityId))];
    const resolvedMap = new Map<string, string>();
    const missingIds: string[] = [];

    for (const id of uniqueIds) {
      const stableId = await resolveEntityStableId(db, id);
      if (stableId) {
        resolvedMap.set(id, stableId);
      } else {
        missingIds.push(id);
      }
    }

    if (missingIds.length > 0) {
      return validationError(c, `Referenced entities not found: ${missingIds.join(", ")}`);
    }

    const allVals = items.map((item) =>
      summaryValues(item, resolvedMap.get(item.entityId)!)
    );

    const results = await db
      .insert(summaries)
      .values(allVals)
      .onConflictDoUpdate({
        target: summaries.entityId,
        set: {
          entityType: sql`excluded."entity_type"`,
          oneLiner: sql`excluded."one_liner"`,
          summary: sql`excluded."summary"`,
          review: sql`excluded."review"`,
          keyPoints: sql`excluded."key_points"`,
          keyClaims: sql`excluded."key_claims"`,
          model: sql`excluded."model"`,
          tokensUsed: sql`excluded."tokens_used"`,
          generatedAt: sql`now()`,
          updatedAt: sql`now()`,
        },
      })
      .returning({
        entityId: summaries.entityId,
        entityType: summaries.entityType,
      });

    return c.json({ upserted: results.length, results }, 201);
  })

  // ---- GET /stats ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const totalResult = await db.select({ count: count() }).from(summaries);
    const total = totalResult[0].count;

    const byType = await db
      .select({
        entityType: summaries.entityType,
        count: count(),
      })
      .from(summaries)
      .groupBy(summaries.entityType)
      .orderBy(desc(count()));

    const byModel = await db
      .select({
        model: summaries.model,
        count: count(),
      })
      .from(summaries)
      .groupBy(summaries.model)
      .orderBy(desc(count()));

    return c.json({
      total,
      byType: Object.fromEntries(
        byType.map((r) => [r.entityType, r.count])
      ),
      byModel: Object.fromEntries(
        byModel.map((r) => [r.model ?? "unknown", r.count])
      ),
    });
  })

  // ---- GET /all (paginated listing) ----
  .get("/all", async (c) => {
    const parsed = PaginationQuery.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { limit, offset, entityType } = parsed.data;
    const db = getDrizzleDb();

    const conditions = entityType
      ? eq(summaries.entityType, entityType)
      : undefined;

    const rows = await db
      .select()
      .from(summaries)
      .where(conditions)
      .orderBy(asc(summaries.entityId))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(summaries)
      .where(conditions);
    const total = countResult[0].count;

    return c.json({
      summaries: rows.map(formatSummary),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /:entityId (get by entity ID) ----
  .get("/:entityId", async (c) => {
    const rawId = c.req.param("entityId");
    const db = getDrizzleDb();

    // Resolve identifier (slug, stableId, or numericId) to stableId
    const stableId = await resolveEntityStableId(db, rawId);
    const lookupId = stableId ?? rawId;

    const rows = await db
      .select()
      .from(summaries)
      .where(eq(summaries.entityId, lookupId))
      .limit(1);

    if (rows.length === 0) {
      return notFoundError(c, `Summary not found: ${rawId}`);
    }

    return c.json(formatSummary(rows[0]));
  });

export const summariesRoute = summariesApp;
export type SummariesRoute = typeof summariesApp;
