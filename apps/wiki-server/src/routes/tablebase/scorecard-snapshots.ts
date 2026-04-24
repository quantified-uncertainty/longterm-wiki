import { Hono } from "hono";
import { z } from "zod";
import { eq, count, desc, and, ne, inArray } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { scorecardSnapshots } from "../../schema.js";
import { zv, clampedLimit } from "../shared/utils.js";
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
  latest: z.coerce.boolean().optional(),
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

    const where =
      conditions.length === 0
        ? undefined
        : conditions.length === 1
          ? conditions[0]
          : and(...conditions);

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
      // is_latest invariant: at most one TRUE per scorecardSource. The
      // partial unique index enforces it at the storage level; this hook
      // resets siblings to FALSE when a new is_latest=true row is upserted,
      // so the upsert can succeed without a unique-violation.
      postUpsert: async (tx, items) => {
        const latestPerSource = new Map<string, string>();
        for (const item of items) {
          if (item.isLatest) {
            // If multiple items in the batch claim is_latest for the same
            // source, the last one wins — sync handlers are not the place
            // to enforce intra-batch uniqueness on this field; ingesters
            // should send at most one is_latest=true per source.
            latestPerSource.set(item.scorecardSource, item.id);
          }
        }
        if (latestPerSource.size === 0) return;

        for (const [source, latestId] of latestPerSource) {
          await tx
            .update(scorecardSnapshots)
            .set({ isLatest: false, updatedAt: new Date() })
            .where(
              and(
                eq(scorecardSnapshots.scorecardSource, source),
                ne(scorecardSnapshots.id, latestId),
                eq(scorecardSnapshots.isLatest, true),
              ),
            );
        }
      },
    }),
  )

  .post("/delete-batch", deleteBatchHandler(scorecardSnapshots, null, { maxIdLength: 100 }));

// Type-check unused imports
void inArray;

export const scorecardSnapshotsRoute = scorecardSnapshotsApp;
export type ScorecardSnapshotsRoute = typeof scorecardSnapshotsApp;
