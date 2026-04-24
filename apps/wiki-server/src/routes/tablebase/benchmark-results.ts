import { Hono } from "hono";
import { z } from "zod";
import { eq, count, desc, sql } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { benchmarkResults, benchmarks } from "../../schema.js";
import {
  validationError,
  zv,
  clampedLimit,
} from "../shared/utils.js";
import { InlineSourcingSchema } from "./sourcing-schema.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { createSyncHandler } from "./sync-factory.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

// ---- Query schemas ----

const ByBenchmarkQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 100),
  offset: z.coerce.number().int().min(0).default(0),
});

const ByModelQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 100),
  offset: z.coerce.number().int().min(0).default(0),
});

const AllQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 200),
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
  sourcing: InlineSourcingSchema.optional(),
  claimIds: z.array(z.number().int().positive()).optional(),
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
  .post(
    "/sync",
    createSyncHandler({
      name: "benchmark-results",
      table: benchmarkResults,
      syncSchema: SyncBenchmarkResultItemSchema,
      entityRefs: ["modelId"],
      // benchmarkId references the `benchmarks` table (not entities), so we
      // validate and auto-resolve slugs→IDs in a preValidate hook.
      preValidate: async (c, db, items) => {
        const benchmarkIds = [...new Set(items.map((i) => i.benchmarkId))];
        if (benchmarkIds.length === 0) return null;
        const placeholders = benchmarkIds.map((id) => sql`${id}`);
        const inList = sql.join(placeholders, sql`, `);
        // Check both id (10-char hash) and slug (e.g., "mmlu") since the
        // enrichment agent may submit either format.
        const found = await db.execute<{ id: string; slug: string }>(sql`
          SELECT id, slug FROM benchmarks WHERE id IN (${inList}) OR slug IN (${inList})
        `);
        const foundIdSet = new Set(found.map((r) => r.id));
        const foundSlugSet = new Set(found.map((r) => r.slug));
        const slugToId = new Map(found.map((r) => [r.slug, r.id]));
        const missing = benchmarkIds.filter(
          (id) => !foundIdSet.has(id) && !foundSlugSet.has(id),
        );
        if (missing.length > 0) {
          return validationError(
            c,
            `Benchmark references not found in benchmarks table: ${missing.join(", ")}. Ensure benchmarks are synced first (pnpm crux wiki-server sync-benchmarks).`,
          );
        }
        // Auto-resolve slugs to IDs so the upsert uses the correct FK
        for (const item of items) {
          if (slugToId.has(item.benchmarkId)) {
            item.benchmarkId = slugToId.get(item.benchmarkId)!;
          }
        }
        return null;
      },
      toThing: (item) => ({
        id: item.id,
        thingType: "benchmark-result" as const,
        parentThingId: item.benchmarkId,
        sourceTable: "benchmark_results",
        sourceId: item.id,
        sourceUrl: item.sourceUrl,
      }),
      toVerdict: (item) => ({
        recordType: "benchmark-result",
        recordId: item.id,
        entityId: item.modelId,
        sourceUrl: item.sourceUrl ?? null,
        sourcing: item.sourcing ?? null,
      }),
      claimSupport: {
        recordType: "benchmark-result",
        getClaimIds: (item) => item.claimIds ?? [],
      },
    }),
  )

  .post("/delete-batch", deleteBatchHandler(benchmarkResults, "benchmark_results"));

export const benchmarkResultsRoute = benchmarkResultsApp;
export type BenchmarkResultsRoute = typeof benchmarkResultsApp;
