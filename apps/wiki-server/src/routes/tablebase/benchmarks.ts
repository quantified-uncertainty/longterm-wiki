import { Hono } from "hono";
import { z } from "zod";
import { eq, count, desc } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { benchmarks } from "../../schema.js";
import {
  zv,
  clampedLimit,
} from "../shared/utils.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { createSyncHandler } from "./sync-factory.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

const VALID_CATEGORIES = [
  "coding",
  "reasoning",
  "math",
  "knowledge",
  "multimodal",
  "safety",
  "agentic",
  "general",
] as const;

// ---- Query schemas ----

const AllQuery = z.object({
  category: z.enum(VALID_CATEGORIES).optional(),
  limit: clampedLimit(MAX_PAGE_SIZE, 200),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Sync schema ----

const SyncBenchmarkItemSchema = z.object({
  id: z.string().min(1).max(200),
  slug: z.string().min(1).max(200),
  name: z.string().min(1).max(500),
  category: z.enum(VALID_CATEGORIES).nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
  website: z.string().max(2000).nullable().optional(),
  scoringMethod: z.string().max(50).nullable().optional(),
  higherIsBetter: z.boolean().optional().default(true),
  introducedDate: z.string().max(20).nullable().optional(),
  maintainer: z.string().max(500).nullable().optional(),
  source: z.string().max(2000).nullable().optional(),
});

// ---- Helpers ----

function formatRow(r: typeof benchmarks.$inferSelect) {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    category: r.category,
    description: r.description,
    website: r.website,
    scoringMethod: r.scoringMethod,
    higherIsBetter: r.higherIsBetter,
    introducedDate: r.introducedDate,
    maintainer: r.maintainer,
    source: r.source,
    syncedAt: r.syncedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ---- Route definition (method-chained for Hono RPC type inference) ----

const benchmarksApp = new Hono()

  // ---- GET /stats ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();
    const [statsRow] = await db
      .select({
        total: count(),
      })
      .from(benchmarks);

    // Count by category
    const categoryRows = await db
      .select({
        category: benchmarks.category,
        count: count(),
      })
      .from(benchmarks)
      .groupBy(benchmarks.category);

    const byCategory: Record<string, number> = {};
    for (const row of categoryRows) {
      byCategory[row.category ?? "uncategorized"] = row.count;
    }

    return c.json({ total: statsRow.total, byCategory });
  })

  // ---- GET /all ----
  .get("/all", zv("query", AllQuery), async (c) => {
    const { category, limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(benchmarks)
      .where(category ? eq(benchmarks.category, category) : undefined)
      .orderBy(desc(benchmarks.syncedAt))
      .limit(limit)
      .offset(offset);

    return c.json({ benchmarks: rows.map(formatRow) });
  })

  // ---- GET /:id ----
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const db = getDrizzleDb();

    const [row] = await db
      .select()
      .from(benchmarks)
      .where(eq(benchmarks.id, id))
      .limit(1);

    if (!row) {
      return c.json({ error: "not_found", message: `Benchmark ${id} not found` }, 404);
    }

    return c.json(formatRow(row));
  })

  // ---- POST /sync ----
  .post(
    "/sync",
    createSyncHandler({
      name: "benchmarks",
      table: benchmarks,
      syncSchema: SyncBenchmarkItemSchema,
      toThing: (item) => ({
        id: item.id,
        thingType: "benchmark" as const,
        sourceTable: "benchmarks",
        sourceId: item.id,
        sourceUrl: item.website,
        wikiId: item.slug,
      }),
    }),
  )

  .post("/delete-batch", deleteBatchHandler(benchmarks, "benchmarks"));

export const benchmarksRoute = benchmarksApp;
export type BenchmarksRoute = typeof benchmarksApp;
