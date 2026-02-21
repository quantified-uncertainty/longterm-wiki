import { Hono } from "hono";
import { z } from "zod";
import { eq, desc, count, inArray } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { autoUpdateNewsItems, autoUpdateRuns } from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  firstOrThrow,
} from "./utils.js";

export const autoUpdateNewsRoute = new Hono();

// ---- Constants ----

const MAX_BATCH_SIZE = 500;
const MAX_PAGE_SIZE = 1000;

// ---- Schemas ----

const NewsItemSchema = z.object({
  title: z.string().min(1).max(2000),
  url: z.string().min(1).max(5000),
  sourceId: z.string().min(1).max(200),
  publishedAt: z.string().max(100).nullable().optional(),
  summary: z.string().max(5000).nullable().optional(),
  relevanceScore: z.number().int().min(0).max(100).nullable().optional(),
  topics: z.array(z.string().max(200)).optional().default([]),
  entities: z.array(z.string().max(200)).optional().default([]),
  routedToPageId: z.string().max(200).nullable().optional(),
  routedToPageTitle: z.string().max(500).nullable().optional(),
  routedTier: z.string().max(50).nullable().optional(),
});

const CreateBatchSchema = z.object({
  runId: z.number().int().positive(),
  items: z.array(NewsItemSchema).min(1).max(MAX_BATCH_SIZE),
});

const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const DashboardQuery = z.object({
  runs: z.coerce.number().int().min(1).max(50).default(10),
});

// ---- Helpers ----

function mapNewsRow(r: typeof autoUpdateNewsItems.$inferSelect) {
  return {
    id: r.id,
    runId: r.runId,
    title: r.title,
    url: r.url,
    sourceId: r.sourceId,
    publishedAt: r.publishedAt,
    summary: r.summary,
    relevanceScore: r.relevanceScore,
    topics: r.topicsJson ?? [],
    entities: r.entitiesJson ?? [],
    routedToPageId: r.routedToPageId,
    routedToPageTitle: r.routedToPageTitle,
    routedTier: r.routedTier,
    createdAt: r.createdAt,
  };
}

// ---- POST /batch (insert news items for a run) ----

autoUpdateNewsRoute.post("/batch", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = CreateBatchSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { runId, items } = parsed.data;
  const db = getDrizzleDb();

  const results = await db.transaction(async (tx) => {
    return await tx
      .insert(autoUpdateNewsItems)
      .values(
        items.map((d) => ({
          runId,
          title: d.title,
          url: d.url,
          sourceId: d.sourceId,
          publishedAt: d.publishedAt ?? null,
          summary: d.summary ?? null,
          relevanceScore: d.relevanceScore ?? null,
          topicsJson: d.topics.length > 0 ? d.topics : null,
          entitiesJson: d.entities.length > 0 ? d.entities : null,
          routedToPageId: d.routedToPageId ?? null,
          routedToPageTitle: d.routedToPageTitle ?? null,
          routedTier: d.routedTier ?? null,
        }))
      )
      .returning({ id: autoUpdateNewsItems.id });
  });

  return c.json({ inserted: results.length }, 201);
});

// ---- GET /by-run/:runId (news items for a specific run) ----

autoUpdateNewsRoute.get("/by-run/:runId", async (c) => {
  const runId = parseInt(c.req.param("runId"), 10);
  if (isNaN(runId)) return validationError(c, "runId must be an integer");

  const db = getDrizzleDb();
  const rows = await db
    .select()
    .from(autoUpdateNewsItems)
    .where(eq(autoUpdateNewsItems.runId, runId))
    .orderBy(desc(autoUpdateNewsItems.relevanceScore));

  return c.json({ items: rows.map(mapNewsRow) });
});

// ---- GET /recent (recent news items across all runs) ----

autoUpdateNewsRoute.get("/recent", async (c) => {
  const parsed = PaginationQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { limit, offset } = parsed.data;
  const db = getDrizzleDb();

  // Join with runs to get the run date
  const rows = await db
    .select({
      item: autoUpdateNewsItems,
      runDate: autoUpdateRuns.date,
    })
    .from(autoUpdateNewsItems)
    .innerJoin(autoUpdateRuns, eq(autoUpdateNewsItems.runId, autoUpdateRuns.id))
    .orderBy(desc(autoUpdateRuns.date), desc(autoUpdateNewsItems.relevanceScore))
    .limit(limit)
    .offset(offset);

  const countResult = await db
    .select({ count: count() })
    .from(autoUpdateNewsItems);
  const total = countResult[0].count;

  return c.json({
    items: rows.map((r) => ({
      ...mapNewsRow(r.item),
      runDate: r.runDate,
    })),
    total,
    limit,
    offset,
  });
});

// ---- GET /by-page/:pageId (news items routed to a specific page) ----

autoUpdateNewsRoute.get("/by-page/:pageId", async (c) => {
  const pageId = c.req.param("pageId");
  const db = getDrizzleDb();

  const rows = await db
    .select({
      item: autoUpdateNewsItems,
      runDate: autoUpdateRuns.date,
    })
    .from(autoUpdateNewsItems)
    .innerJoin(autoUpdateRuns, eq(autoUpdateNewsItems.runId, autoUpdateRuns.id))
    .where(eq(autoUpdateNewsItems.routedToPageId, pageId))
    .orderBy(desc(autoUpdateRuns.date), desc(autoUpdateNewsItems.relevanceScore));

  return c.json({
    items: rows.map((r) => ({
      ...mapNewsRow(r.item),
      runDate: r.runDate,
    })),
  });
});

// ---- GET /dashboard (optimized endpoint for news dashboard, last N runs) ----

autoUpdateNewsRoute.get("/dashboard", async (c) => {
  const parsed = DashboardQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { runs: maxRuns } = parsed.data;
  const db = getDrizzleDb();

  // Get the last N run IDs
  const recentRuns = await db
    .select({ id: autoUpdateRuns.id, date: autoUpdateRuns.date })
    .from(autoUpdateRuns)
    .orderBy(desc(autoUpdateRuns.startedAt))
    .limit(maxRuns);

  if (recentRuns.length === 0) {
    return c.json({ items: [], runDates: [] });
  }

  const runIds = recentRuns.map((r) => r.id);
  const runDateMap = new Map(recentRuns.map((r) => [r.id, r.date]));

  // Fetch all news items for these runs
  const rows = await db
    .select()
    .from(autoUpdateNewsItems)
    .where(inArray(autoUpdateNewsItems.runId, runIds))
    .orderBy(desc(autoUpdateNewsItems.relevanceScore));

  return c.json({
    items: rows.map((r) => ({
      ...mapNewsRow(r),
      runDate: runDateMap.get(r.runId) ?? null,
    })),
    runDates: [...new Set(recentRuns.map((r) => r.date))],
  });
});
