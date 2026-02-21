import { Hono } from "hono";
import { z } from "zod";
import { eq, count, desc, sql, and } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { hallucinationRiskSnapshots } from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
} from "./utils.js";

export const hallucinationRiskRoute = new Hono();

// ---- Constants ----

const MAX_BATCH_SIZE = 700; // one batch per full build (~625 pages)
const MAX_PAGE_SIZE = 200;
const VALID_LEVELS = ["low", "medium", "high"] as const;

// ---- Schemas ----

const SnapshotSchema = z.object({
  pageId: z.string().min(1).max(300),
  score: z.number().int().min(0).max(100),
  level: z.enum(VALID_LEVELS),
  factors: z.array(z.string()).nullable().optional(),
  integrityIssues: z.array(z.string()).nullable().optional(),
});

const BatchSchema = z.object({
  snapshots: z.array(SnapshotSchema).min(1).max(MAX_BATCH_SIZE),
});

const HistoryQuery = z.object({
  page_id: z.string().min(1).max(300),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
});

const StatsQuery = z.object({});

const LatestQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  level: z.enum(VALID_LEVELS).optional(),
});

// ---- POST / (record single snapshot) ----

hallucinationRiskRoute.post("/", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = SnapshotSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const d = parsed.data;
  const db = getDrizzleDb();

  const rows = await db
    .insert(hallucinationRiskSnapshots)
    .values({
      pageId: d.pageId,
      score: d.score,
      level: d.level,
      factors: d.factors ?? null,
      integrityIssues: d.integrityIssues ?? null,
    })
    .returning({
      id: hallucinationRiskSnapshots.id,
      pageId: hallucinationRiskSnapshots.pageId,
      score: hallucinationRiskSnapshots.score,
      level: hallucinationRiskSnapshots.level,
      computedAt: hallucinationRiskSnapshots.computedAt,
    });

  return c.json(rows[0], 201);
});

// ---- POST /batch (record multiple snapshots) ----

hallucinationRiskRoute.post("/batch", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = BatchSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { snapshots } = parsed.data;
  const db = getDrizzleDb();

  const results = await db.transaction(async (tx) => {
    const rows: Array<{ id: number; pageId: string }> = [];
    for (const d of snapshots) {
      const inserted = await tx
        .insert(hallucinationRiskSnapshots)
        .values({
          pageId: d.pageId,
          score: d.score,
          level: d.level,
          factors: d.factors ?? null,
          integrityIssues: d.integrityIssues ?? null,
        })
        .returning({
          id: hallucinationRiskSnapshots.id,
          pageId: hallucinationRiskSnapshots.pageId,
        });
      rows.push(inserted[0]);
    }
    return rows;
  });

  return c.json({ inserted: results.length }, 201);
});

// ---- GET /history?page_id=X (history for a page) ----

hallucinationRiskRoute.get("/history", async (c) => {
  const parsed = HistoryQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { page_id, limit } = parsed.data;
  const db = getDrizzleDb();

  const rows = await db
    .select()
    .from(hallucinationRiskSnapshots)
    .where(eq(hallucinationRiskSnapshots.pageId, page_id))
    .orderBy(desc(hallucinationRiskSnapshots.computedAt))
    .limit(limit);

  return c.json({
    pageId: page_id,
    snapshots: rows.map((r) => ({
      id: r.id,
      score: r.score,
      level: r.level,
      factors: r.factors,
      integrityIssues: r.integrityIssues,
      computedAt: r.computedAt,
    })),
  });
});

// ---- GET /stats (aggregate statistics) ----

hallucinationRiskRoute.get("/stats", async (c) => {
  const parsed = StatsQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  const db = getDrizzleDb();

  // Total snapshots
  const totalResult = await db
    .select({ count: count() })
    .from(hallucinationRiskSnapshots);
  const totalSnapshots = totalResult[0].count;

  // Unique pages
  const pagesResult = await db
    .select({
      count: sql<number>`count(distinct ${hallucinationRiskSnapshots.pageId})`,
    })
    .from(hallucinationRiskSnapshots);
  const uniquePages = Number(pagesResult[0].count);

  // Level distribution (from latest snapshot per page)
  const levelDist = await db
    .select({
      level: hallucinationRiskSnapshots.level,
      count: count(),
    })
    .from(hallucinationRiskSnapshots)
    .where(
      sql`(${hallucinationRiskSnapshots.pageId}, ${hallucinationRiskSnapshots.computedAt}) IN (
        SELECT page_id, MAX(computed_at) FROM hallucination_risk_snapshots GROUP BY page_id
      )`
    )
    .groupBy(hallucinationRiskSnapshots.level);

  return c.json({
    totalSnapshots,
    uniquePages,
    levelDistribution: Object.fromEntries(
      levelDist.map((r) => [r.level, r.count])
    ),
  });
});

// ---- GET /latest (latest score per page) ----

hallucinationRiskRoute.get("/latest", async (c) => {
  const parsed = LatestQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { limit, offset, level } = parsed.data;
  const db = getDrizzleDb();

  // Use a subquery to get the most recent snapshot per page
  const conditions = [
    sql`(${hallucinationRiskSnapshots.pageId}, ${hallucinationRiskSnapshots.computedAt}) IN (
      SELECT page_id, MAX(computed_at) FROM hallucination_risk_snapshots GROUP BY page_id
    )`,
  ];

  if (level) {
    conditions.push(eq(hallucinationRiskSnapshots.level, level));
  }

  const rows = await db
    .select()
    .from(hallucinationRiskSnapshots)
    .where(and(...conditions))
    .orderBy(desc(hallucinationRiskSnapshots.score))
    .limit(limit)
    .offset(offset);

  return c.json({
    pages: rows.map((r) => ({
      pageId: r.pageId,
      score: r.score,
      level: r.level,
      factors: r.factors,
      integrityIssues: r.integrityIssues,
      computedAt: r.computedAt,
    })),
  });
});
