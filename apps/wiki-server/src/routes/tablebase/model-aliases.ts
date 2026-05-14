/**
 * Model aliases — maps lowercased external alias strings to canonical AI-model
 * entity stable_ids. Phase 2 ingesters consult this table at resolution time
 * (raw model name → entities.stable_id). Misses go to benchmark_results_pending
 * for human review.
 *
 * QUA-689 — Phase 2 of the AI safety data layer.
 *
 * Schema: see modelAliases in apps/wiki-server/src/schema.ts.
 */

import { Hono } from "hono";
import { z } from "zod";
import { and, count, desc, eq } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { modelAliases } from "../../schema.js";
import { zv, clampedLimit } from "../shared/utils.js";
import { buildSearchCondition } from "../shared/query-helpers.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { createSyncHandler } from "./sync-factory.js";
import { paginatedQuery } from "../shared/paginated-query.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 1000;

const VALID_CONFIDENCE = ["exact", "fuzzy", "manual"] as const;

// ---- Query schemas ----

const AllQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 200),
  offset: z.coerce.number().int().min(0).default(0),
  modelStableId: z.string().max(200).optional(),
  source: z.string().max(100).optional(),
  confidence: z.enum(VALID_CONFIDENCE).optional(),
  q: z.string().max(200).optional(),
});

const ResolveQuery = z.object({
  alias: z.string().min(1).max(500),
});

// ---- Sync schema ----

const SyncModelAliasItemSchema = z.object({
  // The factory uses item.id as the conflict target by default; we override
  // conflictTarget below to use modelAliases.alias instead. The schema
  // surfaces alias as the natural key and validates lowercase form.
  alias: z
    .string()
    .min(1)
    .max(500)
    .refine((s) => s === s.toLowerCase(), {
      message: "alias must be lowercased before sync",
    }),
  modelStableId: z.string().min(1).max(200),
  source: z.string().min(1).max(100).default("yaml-seed"),
  confidence: z.enum(VALID_CONFIDENCE).default("exact"),
});

// ---- Helpers ----

function formatRow(r: typeof modelAliases.$inferSelect) {
  return {
    alias: r.alias,
    modelStableId: r.modelStableId,
    source: r.source,
    confidence: r.confidence,
    syncedAt: r.syncedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ---- Route ----

const modelAliasesApp = new Hono()

  // GET /stats — distribution by source + confidence, used by quarantine UI.
  .get("/stats", async (c) => {
    const db = getDrizzleDb();
    const [[{ total }], bySource, byConfidence] = await Promise.all([
      db.select({ total: count() }).from(modelAliases),
      db
        .select({ source: modelAliases.source, total: count() })
        .from(modelAliases)
        .groupBy(modelAliases.source),
      db
        .select({ confidence: modelAliases.confidence, total: count() })
        .from(modelAliases)
        .groupBy(modelAliases.confidence),
    ]);
    return c.json({
      total,
      bySource: bySource.map((r) => ({ source: r.source, total: r.total })),
      byConfidence: byConfidence.map((r) => ({
        confidence: r.confidence,
        total: r.total,
      })),
    });
  })

  // GET /all — paginated list, optionally filtered.
  .get("/all", zv("query", AllQuery), async (c) => {
    const { limit, offset, modelStableId, source, confidence, q } =
      c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [];
    if (modelStableId)
      conditions.push(eq(modelAliases.modelStableId, modelStableId));
    if (source) conditions.push(eq(modelAliases.source, source));
    if (confidence) conditions.push(eq(modelAliases.confidence, confidence));
    if (q) {
      const search = buildSearchCondition(
        [modelAliases.alias, modelAliases.modelStableId],
        q,
      );
      if (search) conditions.push(search);
    }

    const where = conditions.length ? and(...conditions) : undefined;

    const { rows, total } = await paginatedQuery({
      query: db
        .select()
        .from(modelAliases)
        .where(where)
        .orderBy(desc(modelAliases.createdAt), modelAliases.alias)
        .limit(limit)
        .offset(offset),
      countQuery: db.select({ count: count() }).from(modelAliases).where(where),
      formatRow,
    });

    return c.json({
      items: rows,
      total,
      limit,
      offset,
    });
  })

  // GET /resolve?alias=... — single-shot lookup used by ingesters at
  // resolve time. Returns 404 on miss so callers can branch into the
  // quarantine path with a single round-trip.
  .get("/resolve", zv("query", ResolveQuery), async (c) => {
    const { alias } = c.req.valid("query");
    const db = getDrizzleDb();

    const [row] = await db
      .select()
      .from(modelAliases)
      .where(eq(modelAliases.alias, alias.toLowerCase()))
      .limit(1);

    if (!row) {
      return c.json(
        { resolved: false, alias: alias.toLowerCase() },
        404,
      );
    }

    return c.json({
      resolved: true,
      alias: row.alias,
      modelStableId: row.modelStableId,
      source: row.source,
      confidence: row.confidence,
    });
  })

  // POST /sync — bulk upsert.
  .post(
    "/sync",
    createSyncHandler({
      name: "model-aliases",
      table: modelAliases,
      syncSchema: SyncModelAliasItemSchema,
      // alias is the PK (not id). conflictTarget overrides the factory's
      // default; auditRecordType is omitted because the factory writes
      // `recordId: row.id`, which model_aliases doesn't have. entityRefs
      // shorthand is skipped because the FK target is entities.stable_id,
      // not .id — the PG constraint catches unknown stable_ids at upsert
      // time.
      conflictTarget: modelAliases.alias,
      naturalKey: (item) => item.alias,
      naturalKeyError:
        "Duplicate alias in batch — model_aliases.alias is the primary key, intra-batch dedup before sync",
      toRow: (item, now) => ({
        alias: item.alias,
        modelStableId: item.modelStableId,
        source: item.source,
        confidence: item.confidence,
        syncedAt: now,
        updatedAt: now,
      }),
    }),
  )

  // DELETE batch — mostly used by /internal/benchmark-quarantine when
  // rejecting a fuzzy alias that should never have been added.
  .post(
    "/delete-batch",
    deleteBatchHandler(modelAliases, null, {
      pkColumn: modelAliases.alias,
      maxIdLength: 500,
      label: "model-aliases",
    }),
  );

export const modelAliasesRoute = modelAliasesApp;
export type ModelAliasesRoute = typeof modelAliasesApp;
