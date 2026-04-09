import { Hono } from "hono";
import { z } from "zod";
import { eq, count, desc, sql } from "drizzle-orm";
import { getDrizzleDb, getDb } from "../../db.js";
import { logger } from "../../logger.js";
import { benchmarkResults, benchmarks } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
  clampedLimit,
} from "../shared/utils.js";
import { upsertThingsInTx } from "../shared/thing-sync.js";
import { validateEntityRefs } from "../shared/validate-entity-refs.js";
import { InlineSourcingSchema } from "./sourcing-schema.js";
import { writeInlineVerdicts, logSourceCheckCoverage } from "./write-inline-verdicts.js";
import { validateClaimRefs, linkClaimsToRecords } from "../shared/validate-claims.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";

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

    // Validate FK references before inserting.
    // benchmarkId references the `benchmarks` table (not entities), so check it separately.
    // modelId references entities.stable_id, so use the standard entity validation.
    // Check benchmarkIds against the benchmarks table.
    // This always runs — benchmarkId is a real FK to `benchmarks`, and skipping
    // this check would let invalid references through to the upsert.
    const benchmarkIds = [...new Set(parsed.data.items.map((i) => i.benchmarkId))];
    if (benchmarkIds.length > 0) {
      const placeholders = benchmarkIds.map((id) => sql`${id}`);
      const inList = sql.join(placeholders, sql`, `);
      // Check both id (10-char hash) and slug (e.g., "mmlu") since the enrichment
      // agent may submit either format.
      const found = await db.execute<{ id: string; slug: string }>(sql`
        SELECT id, slug FROM benchmarks WHERE id IN (${inList}) OR slug IN (${inList})
      `);
      const foundIdSet = new Set(found.map((r) => r.id));
      const foundSlugSet = new Set(found.map((r) => r.slug));
      // Build slug→id mapping for auto-resolution
      const slugToId = new Map(found.map((r) => [r.slug, r.id]));
      const missing = benchmarkIds.filter((id) => !foundIdSet.has(id) && !foundSlugSet.has(id));
      if (missing.length > 0) {
        return validationError(
          c,
          `Benchmark references not found in benchmarks table: ${missing.join(", ")}. Ensure benchmarks are synced first (pnpm crux wiki-server sync-benchmarks).`,
        );
      }
      // Auto-resolve slugs to IDs so the upsert uses the correct FK
      for (const item of parsed.data.items) {
        if (slugToId.has(item.benchmarkId)) {
          item.benchmarkId = slugToId.get(item.benchmarkId)!;
        }
      }
    }

    // Check modelIds against the entities table. validateEntityRefs() handles
    // the ?skipEntityValidation=true bypass internally and logs loudly when used
    // (issue #4017). Entity sync order may vary, but benchmark refs are always
    // required, hence the bypass exists for migration scenarios only.
    const modelRefError = await validateEntityRefs(c, db, [
      { fieldName: "modelId", ids: parsed.data.items.map((i) => i.modelId) },
    ]);
    if (modelRefError) return modelRefError;

    // Validate claim references
    const items = parsed.data.items;
    const allClaimIds = items.flatMap((i) => i.claimIds ?? []);
    if (allClaimIds.length > 0) {
      const rawDb = getDb();
      const claimError = await validateClaimRefs(rawDb, allClaimIds);
      if (claimError) return validationError(c, claimError);
    }

    const now = new Date();
    let upserted = 0;
    let verdictsResult = { written: 0 };

    await db.transaction(async (tx) => {
      const allVals = items.map((item) => ({
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
      }));

      await tx
        .insert(benchmarkResults)
        .values(allVals)
        .onConflictDoUpdate({
          target: benchmarkResults.id,
          set: {
            benchmarkId: sql`excluded.benchmark_id`,
            modelId: sql`excluded.model_id`,
            score: sql`excluded.score`,
            unit: sql`excluded.unit`,
            date: sql`excluded.date`,
            sourceUrl: sql`excluded.source_url`,
            notes: sql`excluded.notes`,
            syncedAt: sql`excluded.synced_at`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
      upserted = allVals.length;

      // Dual-write to things table
      await upsertThingsInTx(
        tx,
        items.map((br) => ({
          id: br.id,
          thingType: "benchmark-result" as const,
          title: `${br.modelId} on ${br.benchmarkId}: ${br.score}`,
          sourceTable: "benchmark_results",
          sourceId: br.id,
          sourceUrl: br.sourceUrl,
        }))
      );

      // Write inline source-check verdicts atomically within the same transaction
      verdictsResult = await writeInlineVerdicts(
        tx,
        items.map((item) => ({
          recordType: "benchmark-result",
          recordId: item.id,
          entityId: item.modelId,
          sourceUrl: item.sourceUrl ?? null,
          sourcing: item.sourcing ?? null,
        }))
      );
    });

    logSourceCheckCoverage("benchmark-results/sync", items.length, verdictsResult.written);

    // Link verified claims to records (best-effort — records already committed)
    let claimsLinked = 0;
    let claimLinkingError: string | null = null;
    if (allClaimIds.length > 0) {
      try {
        const rawDb = getDb();
        const linkResult = await linkClaimsToRecords(rawDb, items.map((item) => ({
          recordId: item.id,
          recordType: "benchmark-result",
          claimIds: item.claimIds,
        })));
        claimsLinked = linkResult.linked;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        claimLinkingError = msg;
        logger.warn({ error: msg }, "claim linking failed (records already committed)");
      }
    }

    return c.json({ upserted, verdictsWritten: verdictsResult.written, claimsLinked, ...(claimLinkingError && { claimLinkingError }) });
  })

  .post("/delete-batch", deleteBatchHandler(benchmarkResults, "benchmark_results"));

export const benchmarkResultsRoute = benchmarkResultsApp;
export type BenchmarkResultsRoute = typeof benchmarkResultsApp;
