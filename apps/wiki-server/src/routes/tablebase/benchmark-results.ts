import { Hono } from "hono";
import { z } from "zod";
import { eq, count, desc } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { benchmarkResults, benchmarks } from "../../schema.js";
import {
  zv,
  clampedLimit,
} from "../shared/utils.js";
import { InlineSourcingSchema } from "./sourcing-schema.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { createSyncHandler } from "./sync-factory.js";
import { paginatedQuery } from "../shared/paginated-query.js";
import { VALID_TESTED_BY, resolveBenchmarkRefs } from "./benchmark-shared.js";

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
  // Provenance — added by QUA-689 Phase 2 foundation. Defaults preserve
  // backwards compatibility with pre-Phase-2 ingesters that didn't supply
  // these fields. The tested_by default 'unknown' lets the existing 357
  // prod rows pass the CHECK on first sync without an explicit backfill.
  testedBy: z.enum(VALID_TESTED_BY).default("unknown"),
  testedByOrgId: z.string().max(200).nullable().optional(),
  evaluationDate: z.string().max(20).nullable().optional(),
  methodologyNotes: z.string().max(5000).nullable().optional(),
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
    testedBy: r.testedBy,
    testedByOrgId: r.testedByOrgId,
    evaluationDate: r.evaluationDate,
    methodologyNotes: r.methodologyNotes,
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

    const { rows, total } = await paginatedQuery({
      query: db
        .select()
        .from(benchmarkResults)
        .orderBy(desc(benchmarkResults.syncedAt))
        .limit(limit)
        .offset(offset),
      countQuery: db.select({ count: count() }).from(benchmarkResults),
      formatRow,
    });

    return c.json({ benchmarkResults: rows, total, limit, offset });
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

    const where = eq(benchmarkResults.benchmarkId, benchmarkId);

    const { rows, total } = await paginatedQuery({
      query: db
        .select()
        .from(benchmarkResults)
        .where(where)
        .orderBy(scoreOrder)
        .limit(limit)
        .offset(offset),
      countQuery: db.select({ count: count() }).from(benchmarkResults).where(where),
      formatRow,
    });

    return c.json({ benchmarkResults: rows, total, limit, offset });
  })

  // ---- GET /by-model/:modelId ----
  .get("/by-model/:modelId", zv("query", ByModelQuery), async (c) => {
    const modelId = c.req.param("modelId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const where = eq(benchmarkResults.modelId, modelId);

    const { rows, total } = await paginatedQuery({
      query: db
        .select()
        .from(benchmarkResults)
        .where(where)
        .orderBy(desc(benchmarkResults.score))
        .limit(limit)
        .offset(offset),
      countQuery: db.select({ count: count() }).from(benchmarkResults).where(where),
      formatRow,
    });

    return c.json({ benchmarkResults: rows, total, limit, offset });
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
      // validate and auto-resolve slugs→IDs via the shared helper.
      preValidate: (c, db, items) => resolveBenchmarkRefs(c, db, items),
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
