import { Hono } from "hono";
import { z } from "zod";
import { eq, count, desc, sql } from "drizzle-orm";
import { getDrizzleDb, getDb } from "../db.js";
import { hallucinationRiskSnapshots } from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  firstOrThrow,
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

  return c.json(firstOrThrow(rows, "hallucination risk snapshot insert"), 201);
});

// ---- POST /batch (record multiple snapshots) ----

hallucinationRiskRoute.post("/batch", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = BatchSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { snapshots } = parsed.data;
  const db = getDrizzleDb();

  const allVals = snapshots.map((d) => ({
    pageId: d.pageId,
    score: d.score,
    level: d.level,
    factors: d.factors ?? null,
    integrityIssues: d.integrityIssues ?? null,
  }));

  const results = await db
    .insert(hallucinationRiskSnapshots)
    .values(allVals)
    .returning({
      id: hallucinationRiskSnapshots.id,
      pageId: hallucinationRiskSnapshots.pageId,
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
  const rawDb = getDb();

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

  // Level distribution (from latest snapshot per page) using DISTINCT ON
  const levelDist = await rawDb`
    SELECT level, count(*)::int AS count
    FROM (
      SELECT DISTINCT ON (page_id) level
      FROM hallucination_risk_snapshots
      ORDER BY page_id, computed_at DESC
    ) latest
    GROUP BY level
  `;

  return c.json({
    totalSnapshots,
    uniquePages,
    levelDistribution: Object.fromEntries(
      levelDist.map((r: any) => [r.level, r.count])
    ),
  });
});

// ---- GET /latest (latest score per page) ----

hallucinationRiskRoute.get("/latest", async (c) => {
  const parsed = LatestQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { limit, offset, level } = parsed.data;
  const rawDb = getDb();

  // Use DISTINCT ON for efficient "latest per page" query
  const rows = level
    ? await rawDb`
        SELECT page_id, score, level, factors, integrity_issues, computed_at
        FROM (
          SELECT DISTINCT ON (page_id) *
          FROM hallucination_risk_snapshots
          ORDER BY page_id, computed_at DESC
        ) latest
        WHERE level = ${level}
        ORDER BY score DESC
        LIMIT ${limit} OFFSET ${offset}
      `
    : await rawDb`
        SELECT page_id, score, level, factors, integrity_issues, computed_at
        FROM (
          SELECT DISTINCT ON (page_id) *
          FROM hallucination_risk_snapshots
          ORDER BY page_id, computed_at DESC
        ) latest
        ORDER BY score DESC
        LIMIT ${limit} OFFSET ${offset}
      `;

  return c.json({
    pages: rows.map((r: any) => ({
      pageId: r.page_id,
      score: r.score,
      level: r.level,
      factors: r.factors,
      integrityIssues: r.integrity_issues,
      computedAt: r.computed_at,
    })),
  });
});

// ---- DELETE /cleanup (retention: keep latest N snapshots per page) ----

const CleanupQuery = z.object({
  keep: z.coerce.number().int().min(1).max(1000).default(30),
  dry_run: z
    .enum(["true", "false", "1", "0"])
    .transform((v) => v === "true" || v === "1")
    .default("false"),
});

hallucinationRiskRoute.delete("/cleanup", async (c) => {
  const parsed = CleanupQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { keep, dry_run } = parsed.data;
  const rawDb = getDb();

  if (dry_run) {
    // Count how many rows would be deleted
    const result = await rawDb`
      SELECT count(*)::int AS count
      FROM hallucination_risk_snapshots hrs
      WHERE id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY page_id ORDER BY computed_at DESC
          ) AS rn
          FROM hallucination_risk_snapshots
        ) ranked
        WHERE rn <= ${keep}
      )
    `;
    const wouldDelete = result[0]?.count ?? 0;

    // Total count
    const totalResult = await rawDb`
      SELECT count(*)::int AS total FROM hallucination_risk_snapshots
    `;
    const total = totalResult[0]?.total ?? 0;

    return c.json({
      dryRun: true,
      keep,
      totalSnapshots: total,
      wouldDelete,
      wouldRetain: total - wouldDelete,
    });
  }

  // Actually delete old snapshots, keeping latest `keep` per page
  const result = await rawDb`
    DELETE FROM hallucination_risk_snapshots
    WHERE id NOT IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY page_id ORDER BY computed_at DESC
        ) AS rn
        FROM hallucination_risk_snapshots
      ) ranked
      WHERE rn <= ${keep}
    )
  `;

  const deleted = result.count;

  return c.json({ deleted, keep });
});
