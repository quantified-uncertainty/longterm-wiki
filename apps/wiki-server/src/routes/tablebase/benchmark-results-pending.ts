/**
 * Benchmark results pending — quarantine queue for ingester rows whose source
 * model name didn't resolve to any entity. Reviewed via the
 * /internal/benchmark-quarantine dashboard (follow-up PR).
 *
 * QUA-689 — Phase 2 of the AI safety data layer.
 *
 * Schema: see benchmarkResultsPending in apps/wiki-server/src/schema.ts.
 */

import { Hono } from "hono";
import { z } from "zod";
import { and, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import {
  benchmarkResultsPending,
  benchmarks,
} from "../../schema.js";
import {
  zv,
  clampedLimit,
  validationError,
} from "../shared/utils.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { createSyncHandler } from "./sync-factory.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 500;

const VALID_STATUS = ["pending", "resolved", "rejected"] as const;

const VALID_TESTED_BY = [
  "self-report",
  "leaderboard",
  "aisi-uk",
  "aisi-us",
  "metr",
  "apollo",
  "third-party-paper",
  "epoch-ai",
  "unknown",
] as const;

// ---- Query schemas ----

const ListQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 100),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(VALID_STATUS).optional(),
  ingesterSource: z.string().max(100).optional(),
  benchmarkId: z.string().max(200).optional(),
  q: z.string().max(200).optional(),
});

// ---- Sync schema ----

const SyncBenchmarkResultPendingItemSchema = z.object({
  id: z.string().min(1).max(100),
  benchmarkId: z.string().min(1).max(200),
  rawModelName: z.string().min(1).max(500),
  score: z.number().nullable().optional(),
  scoreText: z.string().max(500).nullable().optional(),
  unit: z.string().max(50).nullable().optional(),
  evaluationDate: z.string().max(20).nullable().optional(),
  testedBy: z.enum(VALID_TESTED_BY).default("unknown"),
  sourceUrl: z.string().max(2000).nullable().optional(),
  methodologyNotes: z.string().max(5000).nullable().optional(),
  rawPayload: z.record(z.unknown()).nullable().optional(),
  status: z.enum(VALID_STATUS).default("pending"),
  ingesterSource: z.string().min(1).max(100),
  resolvedToStableId: z.string().max(200).nullable().optional(),
  resolvedAt: z.string().datetime().nullable().optional(),
  resolvedBy: z.string().max(200).nullable().optional(),
  rejectedReason: z.string().max(1000).nullable().optional(),
});

// ---- Helpers ----

function formatRow(r: typeof benchmarkResultsPending.$inferSelect) {
  return {
    id: r.id,
    benchmarkId: r.benchmarkId,
    rawModelName: r.rawModelName,
    score: r.score,
    scoreText: r.scoreText,
    unit: r.unit,
    evaluationDate: r.evaluationDate,
    testedBy: r.testedBy,
    sourceUrl: r.sourceUrl,
    methodologyNotes: r.methodologyNotes,
    rawPayload: r.rawPayload,
    status: r.status,
    ingesterSource: r.ingesterSource,
    resolvedToStableId: r.resolvedToStableId,
    resolvedAt: r.resolvedAt,
    resolvedBy: r.resolvedBy,
    rejectedReason: r.rejectedReason,
    syncedAt: r.syncedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ---- Route ----

const benchmarkResultsPendingApp = new Hono()

  // GET /stats — quarantine queue depth, used by the dashboard sidebar.
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const [{ total }] = await db
      .select({ total: count() })
      .from(benchmarkResultsPending);

    const byStatus = await db
      .select({
        status: benchmarkResultsPending.status,
        total: count(),
      })
      .from(benchmarkResultsPending)
      .groupBy(benchmarkResultsPending.status);

    const bySource = await db
      .select({
        ingesterSource: benchmarkResultsPending.ingesterSource,
        total: count(),
      })
      .from(benchmarkResultsPending)
      .groupBy(benchmarkResultsPending.ingesterSource);

    return c.json({
      total,
      byStatus: byStatus.map((r) => ({ status: r.status, total: r.total })),
      bySource: bySource.map((r) => ({
        ingesterSource: r.ingesterSource,
        total: r.total,
      })),
    });
  })

  // GET /all — paginated, optionally filtered by status / source / benchmark / search.
  .get("/all", zv("query", ListQuery), async (c) => {
    const { limit, offset, status, ingesterSource, benchmarkId, q } =
      c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [];
    if (status) conditions.push(eq(benchmarkResultsPending.status, status));
    if (ingesterSource)
      conditions.push(eq(benchmarkResultsPending.ingesterSource, ingesterSource));
    if (benchmarkId)
      conditions.push(eq(benchmarkResultsPending.benchmarkId, benchmarkId));
    if (q) {
      const pattern = `%${q.toLowerCase()}%`;
      conditions.push(
        or(
          ilike(benchmarkResultsPending.rawModelName, pattern),
          ilike(benchmarkResultsPending.benchmarkId, pattern),
        ),
      );
    }

    const where = conditions.length ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(benchmarkResultsPending)
      .where(where)
      .orderBy(desc(benchmarkResultsPending.createdAt))
      .limit(limit)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: count() })
      .from(benchmarkResultsPending)
      .where(where);

    return c.json({
      items: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // POST /sync — bulk upsert from ingesters.
  .post(
    "/sync",
    createSyncHandler({
      name: "benchmark-results-pending",
      table: benchmarkResultsPending,
      syncSchema: SyncBenchmarkResultPendingItemSchema,
      auditRecordType: "benchmark-results-pending",
      naturalKey: (item) =>
        [
          item.ingesterSource,
          item.benchmarkId,
          item.rawModelName.toLowerCase(),
          item.evaluationDate ?? "",
        ].join("|"),
      naturalKeyError:
        "Duplicate (ingesterSource, benchmarkId, rawModelName, evaluationDate) in batch — see uq_brp_natural_key",
      // benchmarkId references the benchmarks table (not entities), so we
      // can't use the factory's `entityRefs` shorthand. Validate it via
      // preValidate, mirroring benchmark-results.ts. Slug fallback is allowed
      // for ingesters that submit benchmark slugs rather than 10-char IDs.
      preValidate: async (c, db, items) => {
        const benchmarkIds = [...new Set(items.map((i) => i.benchmarkId))];
        if (benchmarkIds.length === 0) return null;
        const placeholders = benchmarkIds.map((id) => sql`${id}`);
        const inList = sql.join(placeholders, sql`, `);
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
            `Benchmark references not found in benchmarks table: ${missing.join(", ")}. Ensure benchmarks are synced first.`,
          );
        }
        for (const item of items) {
          if (slugToId.has(item.benchmarkId)) {
            item.benchmarkId = slugToId.get(item.benchmarkId)!;
          }
        }
        return null;
      },
      toRow: (item, now) => ({
        id: item.id,
        benchmarkId: item.benchmarkId,
        rawModelName: item.rawModelName,
        score: item.score ?? null,
        scoreText: item.scoreText ?? null,
        unit: item.unit ?? null,
        evaluationDate: item.evaluationDate ?? null,
        testedBy: item.testedBy,
        sourceUrl: item.sourceUrl ?? null,
        methodologyNotes: item.methodologyNotes ?? null,
        rawPayload: item.rawPayload ?? null,
        status: item.status,
        ingesterSource: item.ingesterSource,
        resolvedToStableId: item.resolvedToStableId ?? null,
        // Date string from JSON → Date for the timestamptz column.
        resolvedAt: item.resolvedAt ? new Date(item.resolvedAt) : null,
        resolvedBy: item.resolvedBy ?? null,
        rejectedReason: item.rejectedReason ?? null,
        syncedAt: now,
        updatedAt: now,
      }),
    }),
  )

  .post(
    "/delete-batch",
    deleteBatchHandler(benchmarkResultsPending, null, {
      maxIdLength: 100,
      label: "benchmark-results-pending",
    }),
  );

export const benchmarkResultsPendingRoute = benchmarkResultsPendingApp;
export type BenchmarkResultsPendingRoute = typeof benchmarkResultsPendingApp;
