import { Hono } from "hono";
import { z } from "zod";
import { eq, count, desc } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { benchmarkResults, benchmarks } from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
} from "./utils.js";
import { upsertThingsInTx } from "./thing-sync.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

// ---- Query schemas ----

const ByBenchmarkQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const ByModelQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const AllQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Sync schema ----

const SyncBenchmarkResultItemSchema = z.object({
  id: z.string().length(10),
  benchmarkId: z.string().min(1).max(200),
  modelId: z.string().min(1).max(200),
  score: z.number(),
  unit: z.string().max(50).nullable().optional(),
  date: z.string().max(20).nullable().optional(),
  sourceUrl: z.string().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const SyncBenchmarkResultBatchSchema = z.object({
  items: z.array(SyncBenchmarkResultItemSchema).min(1).max(500),
});

// ---- Helpers ----

function formatRow(r: typeof benchmarkResults.$inferSelect) {
  return {
    id: r.id,
    benchmarkId: r.benchmarkId,
    modelId: r.modelId,
    score: r.score,
    unit: r.unit,
    date: r.date,
    sourceUrl: r.sourceUrl,
    notes: r.notes,
    syncedAt: r.syncedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ---- Route definition (method-chained for Hono RPC type inference) ----

const benchmarkResultsApp = new Hono()

  // ---- GET /stats ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();
    const [statsRow] = await db
      .select({ total: count() })
      .from(benchmarkResults);

    return c.json({ total: statsRow.total });
  })

  // ---- GET /all ----
  .get("/all", zv("query", AllQuery), async (c) => {
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(benchmarkResults)
      .orderBy(desc(benchmarkResults.syncedAt))
      .limit(limit)
      .offset(offset);

    return c.json({ benchmarkResults: rows.map(formatRow) });
  })

  // ---- GET /by-benchmark/:benchmarkId ----
  .get("/by-benchmark/:benchmarkId", zv("query", ByBenchmarkQuery), async (c) => {
    const benchmarkId = c.req.param("benchmarkId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    // Get benchmark metadata for sorting direction
    const [benchmark] = await db
      .select({ higherIsBetter: benchmarks.higherIsBetter })
      .from(benchmarks)
      .where(eq(benchmarks.id, benchmarkId))
      .limit(1);

    const scoreOrder = benchmark?.higherIsBetter === false
      ? benchmarkResults.score          // ascending for lower-is-better
      : desc(benchmarkResults.score);   // descending for higher-is-better

    const rows = await db
      .select()
      .from(benchmarkResults)
      .where(eq(benchmarkResults.benchmarkId, benchmarkId))
      .orderBy(scoreOrder)
      .limit(limit)
      .offset(offset);

    return c.json({ benchmarkResults: rows.map(formatRow) });
  })

  // ---- GET /by-model/:modelId ----
  .get("/by-model/:modelId", zv("query", ByModelQuery), async (c) => {
    const modelId = c.req.param("modelId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(benchmarkResults)
      .where(eq(benchmarkResults.modelId, modelId))
      .orderBy(desc(benchmarkResults.score))
      .limit(limit)
      .offset(offset);

    return c.json({ benchmarkResults: rows.map(formatRow) });
  })

  // ---- POST /sync ----
  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncBenchmarkResultBatchSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.issues.map((i) => i.message).join(", "));
    }

    const db = getDrizzleDb();
    const now = new Date();
    let upserted = 0;

    await db.transaction(async (tx) => {
      for (const item of parsed.data.items) {
        await tx
          .insert(benchmarkResults)
          .values({
            id: item.id,
            benchmarkId: item.benchmarkId,
            modelId: item.modelId,
            score: item.score,
            unit: item.unit ?? null,
            date: item.date ?? null,
            sourceUrl: item.sourceUrl ?? null,
            notes: item.notes ?? null,
            syncedAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: benchmarkResults.id,
            set: {
              benchmarkId: item.benchmarkId,
              modelId: item.modelId,
              score: item.score,
              unit: item.unit ?? null,
              date: item.date ?? null,
              sourceUrl: item.sourceUrl ?? null,
              notes: item.notes ?? null,
              syncedAt: now,
              updatedAt: now,
            },
          });
        upserted++;
      }

      // Dual-write to things table
      await upsertThingsInTx(
        tx,
        parsed.data.items.map((br) => ({
          id: br.id,
          thingType: "benchmark-result" as const,
          title: `${br.modelId} on ${br.benchmarkId}: ${br.score}`,
          sourceTable: "benchmark_results",
          sourceId: br.id,
          sourceUrl: br.sourceUrl,
        }))
      );
    });

    return c.json({ upserted });
  });

export const benchmarkResultsRoute = benchmarkResultsApp;
export type BenchmarkResultsRoute = typeof benchmarkResultsApp;
