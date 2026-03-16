/**
 * Build Metrics Route — receives coverage, rankings, schedule, and similarity
 * data computed by build-data.mjs and writes them to PG.
 *
 * All endpoints are fire-and-forget from the build pipeline's perspective:
 * if the server is down, the build continues with data in database.json only.
 *
 * Uses Hono RPC method-chaining for type inference (see wiki-server-rpc-migration.md).
 */

import { Hono } from "hono";
import { z } from "zod";
import { getDb, getDrizzleDb, type SqlQuery } from "../db.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
} from "./utils.js";
import { resolvePageIntIds } from "./page-id-helpers.js";
import { logger as rootLogger } from "../logger.js";

const logger = rootLogger.child({ component: "build-metrics" });

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CoverageItemSchema = z.object({
  pageId: z.string().min(1),
  passing: z.number().int().min(0),
  total: z.number().int().min(0),
  items: z.record(z.string(), z.enum(["green", "amber", "red"])),
});

const SyncCoverageSchema = z.object({
  coverage: z.array(CoverageItemSchema).min(1).max(2000),
});

const ScheduleItemSchema = z.object({
  pageId: z.string().min(1),
  updateFrequency: z.number().int().min(0),
  daysSinceUpdate: z.number().int().min(0),
  daysUntilDue: z.number().int(),
  staleness: z.number().min(0),
  priority: z.number().min(0),
});

const SyncScheduleSchema = z.object({
  items: z.array(ScheduleItemSchema).min(1).max(2000),
});

const RankingItemSchema = z.object({
  pageId: z.string().min(1),
  readerRank: z.number().int().min(1).nullable(),
  researchRank: z.number().int().min(1).nullable(),
  recommendedScore: z.number().nullable(),
});

const SyncRankingsSchema = z.object({
  rankings: z.array(RankingItemSchema).min(1).max(2000),
});

const SimilarityPairSchema = z.object({
  pageId: z.string().min(1),
  similarPageId: z.string().min(1),
  similarity: z.number().int().min(0).max(100),
  rank: z.number().int().min(1).max(10),
});

const SyncSimilaritySchema = z.object({
  pairs: z.array(SimilarityPairSchema).min(0).max(5000),
  replace: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// Advisory lock keys (prevents concurrent sync deadlocks)
// ---------------------------------------------------------------------------

const COVERAGE_SYNC_LOCK = 7_294_810;
const SCHEDULE_SYNC_LOCK = 7_294_811;
const RANKINGS_SYNC_LOCK = 7_294_812;
const SIMILARITY_SYNC_LOCK = 7_294_813;

/** SQL batch size for jsonb_to_recordset operations within a transaction. */
const SQL_BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a batched UPDATE on wiki_pages within a transaction with an advisory lock.
 *
 * Extracts the shared pattern from coverage/schedule/rankings endpoints:
 * resolve slugs → begin tx → lock → batch update → return count.
 */
async function batchedPageUpdate<T extends { pageId: string }>(
  items: T[],
  lockKey: number,
  mapItem: (item: T, intId: number) => Record<string, unknown>,
  buildSql: (tx: SqlQuery, valuesJson: string) => ReturnType<SqlQuery>,
  label: string,
): Promise<number> {
  const db = getDrizzleDb();
  const slugs = items.map((item) => item.pageId);
  const intIdMap = await resolvePageIntIds(db, slugs);

  const rawDb = getDb();
  let updated = 0;

  await rawDb.begin(async (txRaw) => {
    const tx = txRaw as unknown as SqlQuery;
    await tx`SELECT pg_advisory_xact_lock(${lockKey})`;

    for (let i = 0; i < items.length; i += SQL_BATCH_SIZE) {
      const batch = items.slice(i, i + SQL_BATCH_SIZE);
      const values = batch
        .filter((item) => intIdMap.has(item.pageId))
        .map((item) => mapItem(item, intIdMap.get(item.pageId)!));

      if (values.length === 0) continue;

      await buildSql(tx, JSON.stringify(values));
      updated += values.length;
    }
  });

  logger.info({ updated, total: items.length }, `${label} synced`);
  return updated;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const buildMetricsApp = new Hono()

  // ---- POST /coverage ----
  .post("/coverage", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncCoverageSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const updated = await batchedPageUpdate(
      parsed.data.coverage,
      COVERAGE_SYNC_LOCK,
      (item, intId) => ({
        intId,
        passing: item.passing,
        total: item.total,
        items: JSON.stringify(item.items),
      }),
      (tx, json) => tx`
        UPDATE wiki_pages wp
        SET coverage_passing = v.passing,
            coverage_total = v.total,
            coverage_items = v.items::jsonb,
            updated_at = now()
        FROM jsonb_to_recordset(${json}::jsonb)
          AS v("intId" int, passing int, total int, items text)
        WHERE wp.integer_id = v."intId"
      `,
      "Coverage metrics",
    );

    return c.json({ updated });
  })

  // ---- POST /schedule ----
  .post("/schedule", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncScheduleSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const updated = await batchedPageUpdate(
      parsed.data.items,
      SCHEDULE_SYNC_LOCK,
      (item, intId) => ({
        intId,
        updateFrequency: item.updateFrequency,
        daysSinceUpdate: item.daysSinceUpdate,
        daysUntilDue: item.daysUntilDue,
        staleness: item.staleness,
        priority: item.priority,
      }),
      (tx, json) => tx`
        UPDATE wiki_pages wp
        SET update_frequency = v."updateFrequency",
            days_since_update = v."daysSinceUpdate",
            days_until_due = v."daysUntilDue",
            staleness = v.staleness,
            update_priority = v.priority,
            updated_at = now()
        FROM jsonb_to_recordset(${json}::jsonb)
          AS v("intId" int, "updateFrequency" int, "daysSinceUpdate" int, "daysUntilDue" int, staleness real, priority real)
        WHERE wp.integer_id = v."intId"
      `,
      "Schedule metrics",
    );

    return c.json({ updated });
  })

  // ---- POST /rankings ----
  .post("/rankings", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncRankingsSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const updated = await batchedPageUpdate(
      parsed.data.rankings,
      RANKINGS_SYNC_LOCK,
      (item, intId) => ({
        intId,
        readerRank: item.readerRank,
        researchRank: item.researchRank,
        recommendedScore: item.recommendedScore,
      }),
      (tx, json) => tx`
        UPDATE wiki_pages wp
        SET reader_rank = v."readerRank",
            research_rank = v."researchRank",
            recommended_score = v."recommendedScore",
            updated_at = now()
        FROM jsonb_to_recordset(${json}::jsonb)
          AS v("intId" int, "readerRank" int, "researchRank" int, "recommendedScore" real)
        WHERE wp.integer_id = v."intId"
      `,
      "Rankings",
    );

    return c.json({ updated });
  })

  // ---- POST /similarity ----
  .post("/similarity", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncSimilaritySchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { pairs, replace } = parsed.data;
    const db = getDrizzleDb();

    // Collect all page slugs (both source and similar)
    const allSlugs = new Set<string>();
    for (const pair of pairs) {
      allSlugs.add(pair.pageId);
      allSlugs.add(pair.similarPageId);
    }
    const intIdMap = await resolvePageIntIds(db, [...allSlugs]);

    const rawDb = getDb();
    let upserted = 0;

    await rawDb.begin(async (txRaw) => {
      const tx = txRaw as unknown as SqlQuery;
      await tx`SELECT pg_advisory_xact_lock(${SIMILARITY_SYNC_LOCK})`;

      if (replace) {
        await tx`DELETE FROM wikibase_page_similarity`;
      }

      for (let i = 0; i < pairs.length; i += SQL_BATCH_SIZE) {
        const batch = pairs.slice(i, i + SQL_BATCH_SIZE);
        const values = batch
          .filter(
            (p) => intIdMap.has(p.pageId) && intIdMap.has(p.similarPageId)
          )
          .map((p) => ({
            pageIdInt: intIdMap.get(p.pageId)!,
            similarPageIdInt: intIdMap.get(p.similarPageId)!,
            similarity: p.similarity,
            rank: p.rank,
          }));

        if (values.length === 0) continue;

        await tx`
          INSERT INTO wikibase_page_similarity (page_id_int, similar_page_id_int, similarity, rank, synced_at)
          SELECT v."pageIdInt", v."similarPageIdInt", v.similarity, v.rank, now()
          FROM jsonb_to_recordset(${JSON.stringify(values)}::jsonb)
            AS v("pageIdInt" int, "similarPageIdInt" int, similarity int, rank int)
          ON CONFLICT (page_id_int, rank)
          DO UPDATE SET similar_page_id_int = EXCLUDED.similar_page_id_int,
                        similarity = EXCLUDED.similarity,
                        synced_at = now()
        `;

        upserted += values.length;
      }
    });

    logger.info({ upserted, total: pairs.length }, "Similarity data synced");
    return c.json({ upserted });
  })

  // ---- GET /stats ----
  .get("/stats", async (c) => {
    const rawDb = getDb();

    // Coverage stats
    const coverageResult = await rawDb<
      { total: number; with_coverage: number; avg_passing: string; avg_total: string }[]
    >`
      SELECT
        COUNT(*)::int AS total,
        COUNT(coverage_passing)::int AS with_coverage,
        COALESCE(ROUND(AVG(coverage_passing)::numeric, 1), 0) AS avg_passing,
        COALESCE(ROUND(AVG(coverage_total)::numeric, 1), 0) AS avg_total
      FROM wiki_pages
    `;

    // Schedule stats
    const scheduleResult = await rawDb<
      { with_schedule: number; overdue: number; avg_staleness: string }[]
    >`
      SELECT
        COUNT(update_frequency)::int AS with_schedule,
        COUNT(*) FILTER (WHERE days_until_due < 0)::int AS overdue,
        COALESCE(ROUND(AVG(staleness)::numeric, 2), 0) AS avg_staleness
      FROM wiki_pages
      WHERE update_frequency IS NOT NULL
    `;

    // Similarity stats
    const similarityResult = await rawDb<
      { total_pairs: number; unique_pages: number; avg_similarity: string }[]
    >`
      SELECT
        COUNT(*)::int AS total_pairs,
        COUNT(DISTINCT page_id_int)::int AS unique_pages,
        COALESCE(ROUND(AVG(similarity)::numeric, 1), 0) AS avg_similarity
      FROM wikibase_page_similarity
    `;

    const cs = coverageResult[0];
    const ss = scheduleResult[0];
    const sm = similarityResult[0];

    return c.json({
      coverage: {
        totalPages: cs?.total ?? 0,
        withCoverage: cs?.with_coverage ?? 0,
        avgPassing: parseFloat(cs?.avg_passing ?? "0"),
        avgTotal: parseFloat(cs?.avg_total ?? "0"),
      },
      schedule: {
        withSchedule: ss?.with_schedule ?? 0,
        overdue: ss?.overdue ?? 0,
        avgStaleness: parseFloat(ss?.avg_staleness ?? "0"),
      },
      similarity: {
        totalPairs: sm?.total_pairs ?? 0,
        uniquePages: sm?.unique_pages ?? 0,
        avgSimilarity: parseFloat(sm?.avg_similarity ?? "0"),
      },
    });
  });

export const buildMetricsRoute = buildMetricsApp;
export type BuildMetricsRoute = typeof buildMetricsApp;
