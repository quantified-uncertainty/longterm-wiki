import { Hono } from "hono";
import { z } from "zod";
import { eq, desc, sql } from "drizzle-orm";
import { getDrizzleDb, getDb, beginTransaction } from "../../db.js";
import { hallucinationRiskSnapshots } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  firstOrThrow,
  clampedLimit,
} from "../shared/utils.js";
import {
  RiskSnapshotSchema as SharedSnapshotSchema,
  RiskSnapshotBatchSchema,
} from "../../api-types.js";
import { logger as rootLogger } from "../../logger.js";
import { resolvePageIntId, resolvePageIntIds } from "../shared/page-id-helpers.js";

const logger = rootLogger.child({ component: "hallucination-risk" });

// ---- Raw SQL row types ----

interface LevelDistRow {
  level: string;
  count: number;
}

interface RiskPageDbRow {
  page_id: string;
  score: number;
  level: string;
  factors: string[] | null;
  integrity_issues: string[] | null;
  computed_at: string;
}

interface UniqueCountRow {
  count: number;
}

interface ReltuplesRow {
  reltuples: number;
}

// ---- Constants ----

const MAX_PAGE_SIZE = 200;
const VALID_LEVELS = ["low", "medium", "high"] as const;

// ---- Schemas (from shared api-types) ----

const SnapshotSchema = SharedSnapshotSchema;
const BatchSchema = RiskSnapshotBatchSchema;

const HistoryQuery = z.object({
  page_id: z.string().min(1).max(300),
  limit: clampedLimit(MAX_PAGE_SIZE, 50),
});

const StatsQuery = z.object({});

const LatestQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 50),
  offset: z.coerce.number().int().min(0).default(0),
  level: z.enum(VALID_LEVELS).optional(),
});

const CleanupQuery = z.object({
  keep: z.coerce.number().int().min(1).max(1000).default(30),
  dry_run: z
    .enum(["true", "false", "1", "0"])
    .transform((v) => v === "true" || v === "1")
    .default("false"),
});

// ---- Materialized view existence cache ----

/** Cache TTL in milliseconds (5 minutes). */
const MAT_VIEW_CACHE_TTL_MS = 5 * 60 * 1000;

let matViewCachedResult: boolean | null = null;
let matViewCachedAt = 0;

/**
 * Clear the matViewExists cache. Exported for testing.
 */
export function clearMatViewCache(): void {
  matViewCachedResult = null;
  matViewCachedAt = 0;
}

// ---- Helpers ----

/**
 * Refresh the hallucination_risk_latest materialized view.
 * Uses CONCURRENTLY so reads are not blocked during refresh.
 * Falls back to non-concurrent refresh if the view has no unique index yet
 * (e.g., first run before migration fully applies).
 *
 * The refresh is wrapped in a transaction with an extended statement_timeout
 * because materialized view refreshes are background operations that can
 * legitimately take longer (30-60s+) than the default 30s query timeout.
 * SET LOCAL scopes the override to this transaction only.
 */
async function refreshMaterializedView(): Promise<void> {
  try {
    await beginTransaction(async (tx) => {
      await tx`SET LOCAL statement_timeout = '300000'`; // 5 minutes
      await tx`REFRESH MATERIALIZED VIEW CONCURRENTLY hallucination_risk_latest`;
    });
  } catch (err) {
    // CONCURRENTLY requires a unique index; fall back if not available
    logger.warn({ err }, "Concurrent refresh failed, trying non-concurrent");
    await beginTransaction(async (tx) => {
      await tx`SET LOCAL statement_timeout = '300000'`; // 5 minutes
      await tx`REFRESH MATERIALIZED VIEW hallucination_risk_latest`;
    });
  }
}

// ---- Debounced materialized view refresh ----
// The refresh is expensive (can take 30-60s on the small DB instance) and
// blocks other queries via lock contention. Instead of refreshing on every
// batch insert, we debounce: schedule a refresh after a cooldown, and skip
// if one is already running or was completed recently.

const REFRESH_COOLDOWN_MS = 60_000; // minimum 60s between refreshes
let lastRefreshAt = 0;
let refreshRunning = false;
let refreshScheduled = false;

function scheduleMatViewRefresh(): void {
  if (refreshRunning || refreshScheduled) return;

  const elapsed = Date.now() - lastRefreshAt;
  if (elapsed < REFRESH_COOLDOWN_MS) {
    // Too soon — schedule for later
    refreshScheduled = true;
    setTimeout(() => {
      refreshScheduled = false;
      runDebouncedRefresh();
    }, REFRESH_COOLDOWN_MS - elapsed);
    return;
  }

  runDebouncedRefresh();
}

async function runDebouncedRefresh(): Promise<void> {
  if (refreshRunning) return;
  refreshRunning = true;
  try {
    const exists = await matViewExists();
    if (exists) {
      await refreshMaterializedView();
      lastRefreshAt = Date.now();
    }
  } catch (err) {
    logger.warn({ err }, "Background materialized view refresh failed");
  } finally {
    refreshRunning = false;
  }
}

/**
 * Check if the materialized view exists. Returns false during tests
 * or before the migration has been applied.
 *
 * Results are cached for MAT_VIEW_CACHE_TTL_MS (5 minutes) to avoid
 * querying pg_matviews on every request. The view existence only changes
 * during migrations, not between requests.
 */
async function matViewExists(): Promise<boolean> {
  const now = Date.now();
  if (matViewCachedResult !== null && now - matViewCachedAt < MAT_VIEW_CACHE_TTL_MS) {
    return matViewCachedResult;
  }

  const rawDb = getDb();
  const result = await rawDb<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_matviews WHERE matviewname = 'hallucination_risk_latest'
    ) AS exists
  `;
  matViewCachedResult = result[0]?.exists ?? false;
  matViewCachedAt = now;
  return matViewCachedResult;
}

const hallucinationRiskApp = new Hono()

  // ---- POST / (record single snapshot) ----

  .post("/", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SnapshotSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const d = parsed.data;
    const db = getDrizzleDb();

    // Resolve slug to integer ID
    const pageIdInt = await resolvePageIntId(db, d.pageId);

    const rows = await db
      .insert(hallucinationRiskSnapshots)
      .values({
        pageId: pageIdInt,
        score: d.score,
        level: d.level,
        factors: d.factors ?? null,
        integrityIssues: d.integrityIssues ?? null,
      })
      .returning({
        id: hallucinationRiskSnapshots.id,
        score: hallucinationRiskSnapshots.score,
        level: hallucinationRiskSnapshots.level,
        computedAt: hallucinationRiskSnapshots.computedAt,
      });

    const row = firstOrThrow(rows, "hallucination risk snapshot insert");
    return c.json({ ...row, pageId: d.pageId }, 201);
  })

  // ---- POST /batch (record multiple snapshots) ----

  .post("/batch", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = BatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { snapshots } = parsed.data;
    const db = getDrizzleDb();

    // Resolve slugs to integer IDs
    const pageIds = [...new Set(snapshots.map((d) => d.pageId))];
    const intIdMap = await resolvePageIntIds(db, pageIds);

    const allVals = snapshots.map((d) => ({
      pageId: intIdMap.get(d.pageId) ?? null,
      score: d.score,
      level: d.level,
      factors: d.factors ?? null,
      integrityIssues: d.integrityIssues ?? null,
    }));

    const results = await db
      .insert(hallucinationRiskSnapshots)
      .values(allVals)
      .returning({
        id: hallucinationRiskSnapshots.id,
      });

    // Schedule a debounced, non-blocking materialized view refresh.
    // The refresh is expensive and can block other DB queries for 30-60s,
    // so we fire-and-forget with throttling instead of awaiting inline.
    scheduleMatViewRefresh();

    return c.json({ inserted: results.length }, 201);
  })

  // ---- POST /refresh (manually refresh materialized view) ----

  .post("/refresh", async (c) => {
    if (!(await matViewExists())) {
      return c.json({ refreshed: false, reason: "materialized view does not exist" });
    }
    await refreshMaterializedView();
    return c.json({ refreshed: true });
  })

  // ---- GET /history?page_id=X (history for a page) ----

  .get("/history", async (c) => {
    const parsed = HistoryQuery.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { page_id, limit } = parsed.data;
    const db = getDrizzleDb();

    // Resolve slug to integer ID
    const intId = await resolvePageIntId(db, page_id);
    if (intId === null) return c.json({ pageId: page_id, snapshots: [] });

    const rows = await db
      .select()
      .from(hallucinationRiskSnapshots)
      .where(eq(hallucinationRiskSnapshots.pageId, intId))
      .orderBy(desc(hallucinationRiskSnapshots.computedAt))
      .limit(limit);

    return c.json({
      pageId: page_id,
      snapshots: rows.map((r) => ({
        id: r.id,
        score: r.score,
        level: r.level,
        factors: r.factors,
        integrityIssues: r.integrityIssues,
        computedAt: r.computedAt,
      })),
    });
  })

  // ---- GET /stats (aggregate statistics) ----

  .get("/stats", async (c) => {
    const parsed = StatsQuery.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.message);

    const rawDb = getDb();
    const useMatView = await matViewExists();

    // Total snapshots — use pg_class.reltuples for a fast approximate count
    // instead of a full count(*) sequential scan on the base table.
    // reltuples is updated by VACUUM/ANALYZE and is accurate enough for stats display.
    const totalResult = await rawDb<ReltuplesRow[]>`
      SELECT reltuples::int AS reltuples FROM pg_class WHERE relname = 'hallucination_risk_snapshots'
    `;
    const totalSnapshots = Math.max(0, totalResult[0]?.reltuples ?? 0);

    if (useMatView) {
      // Use materialized view for unique pages and level distribution — instant
      const pagesResult = await rawDb<UniqueCountRow[]>`
        SELECT count(*)::int AS count FROM hallucination_risk_latest
      `;
      const uniquePages = pagesResult[0]?.count ?? 0;

      const levelDist = await rawDb<LevelDistRow[]>`
        SELECT level, count(*)::int AS count
        FROM hallucination_risk_latest
        GROUP BY level
      `;

      return c.json({
        totalSnapshots,
        uniquePages,
        levelDistribution: Object.fromEntries(
          levelDist.map((r) => [r.level, r.count])
        ),
      });
    }

    // Fallback: use DISTINCT ON on the base table (slow but correct)
    const db = getDrizzleDb();

    // Use pageIdInt (integer column) for consistency with the DISTINCT ON below
    const pagesResult = await db
      .select({
        count: sql<number>`count(distinct ${hallucinationRiskSnapshots.pageId})`,
      })
      .from(hallucinationRiskSnapshots);
    const uniquePages = Number(pagesResult[0].count);

    const levelDist = await rawDb<LevelDistRow[]>`
      SELECT level, count(*)::int AS count
      FROM (
        -- Exclude NULL page_id rows; DISTINCT ON NULLs would collapse all into one group
        SELECT DISTINCT ON (page_id) level
        FROM hallucination_risk_snapshots
        WHERE page_id IS NOT NULL
        ORDER BY page_id, computed_at DESC
      ) latest
      GROUP BY level
    `;

    return c.json({
      totalSnapshots,
      uniquePages,
      levelDistribution: Object.fromEntries(
        levelDist.map((r) => [r.level, r.count])
      ),
    });
  })

  // ---- GET /latest (latest score per page) ----

  .get("/latest", async (c) => {
    const parsed = LatestQuery.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { limit, offset, level } = parsed.data;
    const rawDb = getDb();
    const useMatView = await matViewExists();

    let rows: RiskPageDbRow[];

    if (useMatView) {
      // Use materialized view — JOIN wiki_pages to convert integer page_id back to text slug
      rows = level
        ? await rawDb<RiskPageDbRow[]>`
            SELECT wp.slug AS page_id, hrl.score, hrl.level, hrl.factors, hrl.integrity_issues, hrl.computed_at
            FROM hallucination_risk_latest hrl
            JOIN wiki_pages wp ON wp.id = hrl.page_id
            WHERE hrl.level = ${level}
            ORDER BY hrl.score DESC
            LIMIT ${limit} OFFSET ${offset}
          `
        : await rawDb<RiskPageDbRow[]>`
            SELECT wp.slug AS page_id, hrl.score, hrl.level, hrl.factors, hrl.integrity_issues, hrl.computed_at
            FROM hallucination_risk_latest hrl
            JOIN wiki_pages wp ON wp.id = hrl.page_id
            ORDER BY hrl.score DESC
            LIMIT ${limit} OFFSET ${offset}
          `;
    } else {
      // Fallback: DISTINCT ON on base table
      rows = level
        ? await rawDb<RiskPageDbRow[]>`
            SELECT wp.slug AS page_id, hrs.score, hrs.level, hrs.factors, hrs.integrity_issues, hrs.computed_at
            FROM (
              SELECT DISTINCT ON (page_id) *
              FROM hallucination_risk_snapshots
              ORDER BY page_id, computed_at DESC
            ) hrs
            JOIN wiki_pages wp ON wp.id = hrs.page_id
            WHERE hrs.level = ${level}
            ORDER BY hrs.score DESC
            LIMIT ${limit} OFFSET ${offset}
          `
        : await rawDb<RiskPageDbRow[]>`
            SELECT wp.slug AS page_id, hrs.score, hrs.level, hrs.factors, hrs.integrity_issues, hrs.computed_at
            FROM (
              SELECT DISTINCT ON (page_id) *
              FROM hallucination_risk_snapshots
              ORDER BY page_id, computed_at DESC
            ) hrs
            JOIN wiki_pages wp ON wp.id = hrs.page_id
            ORDER BY hrs.score DESC
            LIMIT ${limit} OFFSET ${offset}
          `;
    }

    return c.json({
      pages: rows.map((r) => ({
        pageId: r.page_id,
        score: r.score,
        level: r.level,
        factors: r.factors,
        integrityIssues: r.integrity_issues,
        computedAt: r.computed_at,
      })),
    });
  })

  // ---- DELETE /cleanup (retention: keep latest N snapshots per page) ----

  .delete("/cleanup", async (c) => {
    const parsed = CleanupQuery.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { keep, dry_run } = parsed.data;
    const rawDb = getDb();

    if (dry_run) {
      // Count how many rows would be deleted
      const result = await rawDb`
        SELECT count(*)::int AS count
        FROM hallucination_risk_snapshots hrs
        WHERE id NOT IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (
              -- COALESCE to -1 so NULL page_id rows don't all collapse into one partition
              PARTITION BY COALESCE(page_id, -1) ORDER BY computed_at DESC
            ) AS rn
            FROM hallucination_risk_snapshots
          ) ranked
          WHERE rn <= ${keep}
        )
      `;
      const wouldDelete = result[0]?.count ?? 0;

      // Total count
      const totalResult = await rawDb`
        SELECT count(*)::int AS total FROM hallucination_risk_snapshots
      `;
      const total = totalResult[0]?.total ?? 0;

      return c.json({
        dryRun: true,
        keep,
        totalSnapshots: total,
        wouldDelete,
        wouldRetain: total - wouldDelete,
      });
    }

    // Actually delete old snapshots, keeping latest `keep` per page.
    // Use a transaction with elevated statement_timeout (2 minutes) since the
    // default 30s pool timeout can be exceeded on large tables.
    logger.info({ keep }, "Deleting old hallucination risk snapshots");
    let deleted = 0;
    await beginTransaction(async (tx) => {
      await tx`SET LOCAL statement_timeout = '120000'`;
      const result = await tx`
        DELETE FROM hallucination_risk_snapshots
        WHERE id NOT IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (
              -- COALESCE to -1 so NULL page_id rows don't all collapse into one partition
              PARTITION BY COALESCE(page_id, -1) ORDER BY computed_at DESC
            ) AS rn
            FROM hallucination_risk_snapshots
          ) ranked
          WHERE rn <= ${keep}
        )
      `;
      deleted = result.count;
    });

    // Refresh materialized view after cleanup
    try {
      if (await matViewExists()) {
        await refreshMaterializedView();
      }
    } catch (err) {
      logger.warn({ err }, "Failed to refresh materialized view after cleanup");
    }

    return c.json({ deleted, keep });
  });

export const hallucinationRiskRoute = hallucinationRiskApp;
export type HallucinationRiskRoute = typeof hallucinationRiskApp;
