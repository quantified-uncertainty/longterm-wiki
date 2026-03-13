import { Hono } from "hono";
import { z } from "zod";
import { eq, count, sql, desc } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { benchmarks } from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
} from "./utils.js";

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
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Sync schema ----

const SyncBenchmarkItemSchema = z.object({
  id: z.string().length(10),
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

const SyncBenchmarkBatchSchema = z.object({
  items: z.array(SyncBenchmarkItemSchema).min(1).max(200),
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

    const conditions = [];
    if (category) conditions.push(eq(benchmarks.category, category));
    const whereClause =
      conditions.length > 0
        ? conditions.length === 1
          ? conditions[0]
          : sql`${conditions[0]}`
        : undefined;

    const rows = await db
      .select()
      .from(benchmarks)
      .where(whereClause)
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
  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncBenchmarkBatchSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.issues.map((i) => i.message).join(", "));
    }

    const db = getDrizzleDb();
    const now = new Date();
    let upserted = 0;

    await db.transaction(async (tx) => {
      for (const item of parsed.data.items) {
        await tx
          .insert(benchmarks)
          .values({
            id: item.id,
            slug: item.slug,
            name: item.name,
            category: item.category ?? null,
            description: item.description ?? null,
            website: item.website ?? null,
            scoringMethod: item.scoringMethod ?? null,
            higherIsBetter: item.higherIsBetter,
            introducedDate: item.introducedDate ?? null,
            maintainer: item.maintainer ?? null,
            source: item.source ?? null,
            syncedAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: benchmarks.id,
            set: {
              slug: item.slug,
              name: item.name,
              category: item.category ?? null,
              description: item.description ?? null,
              website: item.website ?? null,
              scoringMethod: item.scoringMethod ?? null,
              higherIsBetter: item.higherIsBetter,
              introducedDate: item.introducedDate ?? null,
              maintainer: item.maintainer ?? null,
              source: item.source ?? null,
              syncedAt: now,
              updatedAt: now,
            },
          });
        upserted++;
      }
    });

    return c.json({ upserted });
  });

export const benchmarksRoute = benchmarksApp;
export type BenchmarksRoute = typeof benchmarksApp;
