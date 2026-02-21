import { Hono } from "hono";
import { z } from "zod";
import { eq, count, sql, desc, asc } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { summaries } from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  notFoundError,
} from "./utils.js";

export const summariesRoute = new Hono();

// ---- Constants ----

const MAX_BATCH_SIZE = 200;
const MAX_PAGE_SIZE = 200;

// ---- Schemas ----

const UpsertSummarySchema = z.object({
  entityId: z.string().min(1).max(300),
  entityType: z.string().min(1).max(100),
  oneLiner: z.string().max(1000).nullable().optional(),
  summary: z.string().max(50000).nullable().optional(),
  review: z.string().max(50000).nullable().optional(),
  keyPoints: z.array(z.string().max(2000)).max(50).nullable().optional(),
  keyClaims: z.array(z.string().max(2000)).max(50).nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  tokensUsed: z.number().int().min(0).nullable().optional(),
});

const UpsertBatchSchema = z.object({
  items: z.array(UpsertSummarySchema).min(1).max(MAX_BATCH_SIZE),
});

const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  entityType: z.string().max(100).optional(),
});

// ---- Helpers ----

type SummaryInput = z.infer<typeof UpsertSummarySchema>;

function summaryValues(d: SummaryInput) {
  return {
    entityId: d.entityId,
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

// ---- POST / (upsert single summary) ----

summariesRoute.post("/", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = UpsertSummarySchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const db = getDrizzleDb();
  const vals = summaryValues(parsed.data);

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

  return c.json(rows[0], 201);
});

// ---- POST /batch (upsert multiple summaries) ----

summariesRoute.post("/batch", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = UpsertBatchSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { items } = parsed.data;
  const results: Array<{ entityId: string; entityType: string }> = [];

  const db = getDrizzleDb();
  await db.transaction(async (tx) => {
    for (const item of items) {
      const vals = summaryValues(item);
      const rows = await tx
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
      results.push(rows[0]);
    }
  });

  return c.json({ inserted: results.length, results }, 201);
});

// ---- GET /stats ----

summariesRoute.get("/stats", async (c) => {
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
});

// ---- GET /all (paginated listing) ----

summariesRoute.get("/all", async (c) => {
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
});

// ---- GET /:entityId (get by entity ID) ----

summariesRoute.get("/:entityId", async (c) => {
  const entityId = c.req.param("entityId");
  const db = getDrizzleDb();

  const rows = await db
    .select()
    .from(summaries)
    .where(eq(summaries.entityId, entityId))
    .limit(1);

  if (rows.length === 0) {
    return notFoundError(c, `Summary not found: ${entityId}`);
  }

  return c.json(formatSummary(rows[0]));
});
