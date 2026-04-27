import { Hono } from "hono";
import { z } from "zod";
import { eq, count, desc, and } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { scorecardSnapshots } from "../../schema.js";
import { zv, clampedLimit, qBool } from "../shared/utils.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { createSyncHandler } from "./sync-factory.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

const VALID_SOURCES = [
  "fli_index",
  "saferai",
  "ailabwatch",
  "fmti",
  "seoul_tracker",
] as const;

// ---- Query schemas ----

const AllQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 100),
  offset: z.coerce.number().int().min(0).default(0),
  source: z.enum(VALID_SOURCES).optional(),
  latest: qBool.optional(),
});

// ---- Sync schema ----

const SyncScorecardSnapshotsItemSchema = z.object({
  id: z.string().min(1).max(100),
  scorecardSource: z.enum(VALID_SOURCES),
  waveLabel: z.string().max(200).nullable().optional(),
  publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "ISO date YYYY-MM-DD"),
  sourceUrl: z.string().max(2000).min(1),
  methodologyUrl: z.string().max(2000).nullable().optional(),
  license: z.string().max(100).nullable().optional(),
  orgCount: z.number().int().min(0).max(1000).default(0),
  dimensionCount: z.number().int().min(0).max(1000).default(0),
  notes: z.string().max(5000).nullable().optional(),
  isLatest: z.boolean().default(false),
  sourceActive: z.boolean().default(true),
});

// ---- Helpers ----

function formatRow(r: typeof scorecardSnapshots.$inferSelect) {
  return {
    id: r.id,
    scorecardSource: r.scorecardSource,
    waveLabel: r.waveLabel,
    publishedAt: r.publishedAt,
    capturedAt: r.capturedAt,
    sourceUrl: r.sourceUrl,
    methodologyUrl: r.methodologyUrl,
    license: r.license,
    orgCount: r.orgCount,
    dimensionCount: r.dimensionCount,
    notes: r.notes,
    isLatest: r.isLatest,
    sourceActive: r.sourceActive,
    syncedAt: r.syncedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ---- Route ----

const scorecardSnapshotsApp = new Hono()
  // GET /all
  .get("/all", zv("query", AllQuery), async (c) => {
    const { limit, offset, source, latest } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [];
    if (source) conditions.push(eq(scorecardSnapshots.scorecardSource, source));
    if (latest !== undefined)
      conditions.push(eq(scorecardSnapshots.isLatest, latest));

    const where = conditions.length ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(scorecardSnapshots)
      .where(where)
      .orderBy(
        desc(scorecardSnapshots.publishedAt),
        scorecardSnapshots.scorecardSource,
      )
      .limit(limit)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: count() })
      .from(scorecardSnapshots)
      .where(where);

    return c.json({
      items: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // GET /stats — used by /scorecards directory
  .get("/stats", async (c) => {
    const db = getDrizzleDb();
    const rows = await db
      .select({
        source: scorecardSnapshots.scorecardSource,
        total: count(),
      })
      .from(scorecardSnapshots)
      .groupBy(scorecardSnapshots.scorecardSource);

    const [{ totalSnapshots }] = await db
      .select({ totalSnapshots: count() })
      .from(scorecardSnapshots);

    return c.json({
      bySources: rows.map((r) => ({
        source: r.source,
        snapshots: r.total,
      })),
      totalSnapshots,
    });
  })

  // POST /sync
  .post(
    "/sync",
    createSyncHandler({
      name: "scorecard-snapshots",
      table: scorecardSnapshots,
      syncSchema: SyncScorecardSnapshotsItemSchema,
      auditRecordType: "scorecard_snapshots",
      // is_latest invariant: at most one TRUE per scorecardSource, enforced
      // by the partial unique index uq_scorecard_snapshots_latest_per_source.
      //
      // The naive shape — INSERT with is_latest=true + postUpsert reset of
      // siblings — fails on every multi-wave sync: the partial index blocks
      // the INSERT before postUpsert ever runs (ON CONFLICT (id) doesn't
      // catch this — the conflict is on (source) WHERE is_latest=true).
      //
      // Instead: force is_latest=false on every INSERT so the index is
      // never tripped, then in postUpsert (still inside the tx) reset old
      // siblings and promote the just-inserted row to is_latest=true.
      // Between the two UPDATE statements, no row has is_latest=true, so
      // the partial unique index never fires.
      toRow: (item, now) => ({
        id: item.id,
        scorecardSource: item.scorecardSource,
        waveLabel: item.waveLabel ?? null,
        publishedAt: item.publishedAt,
        sourceUrl: item.sourceUrl,
        methodologyUrl: item.methodologyUrl ?? null,
        license: item.license ?? null,
        orgCount: item.orgCount,
        dimensionCount: item.dimensionCount,
        notes: item.notes ?? null,
        // Force false at insert time; postUpsert promotes the latest row.
        isLatest: false,
        sourceActive: item.sourceActive,
        syncedAt: now,
        updatedAt: now,
      }),
      postUpsert: async (tx, items) => {
        const promoteByLatestId = new Map<string, string>();
        for (const item of items) {
          if (item.isLatest) {
            // Last-write-wins if a batch sends multiple is_latest=true for
            // the same source; ingesters should only send one per source.
            promoteByLatestId.set(item.scorecardSource, item.id);
          }
        }
        if (promoteByLatestId.size === 0) return;

        const now = new Date();
        for (const [source, latestId] of promoteByLatestId) {
          // Step 1: clear any existing is_latest=true for this source
          // (both old siblings and, defensively, our newly-inserted row
          // even though toRow already set it false). Single statement
          // touches at most one row thanks to the partial unique index.
          await tx
            .update(scorecardSnapshots)
            .set({ isLatest: false, updatedAt: now })
            .where(
              and(
                eq(scorecardSnapshots.scorecardSource, source),
                eq(scorecardSnapshots.isLatest, true),
              ),
            );
          // Step 2: promote the new row.
          await tx
            .update(scorecardSnapshots)
            .set({ isLatest: true, updatedAt: now })
            .where(eq(scorecardSnapshots.id, latestId));
        }
      },
    }),
  )

  .post("/delete-batch", deleteBatchHandler(scorecardSnapshots, null, { maxIdLength: 100 }));

export const scorecardSnapshotsRoute = scorecardSnapshotsApp;
export type ScorecardSnapshotsRoute = typeof scorecardSnapshotsApp;
