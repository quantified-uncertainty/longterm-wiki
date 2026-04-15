/**
 * things_search refresh endpoint + staleness query.
 *
 * POST /refresh — run REFRESH MATERIALIZED VIEW CONCURRENTLY things_search.
 *                 Called hourly by the groundskeeper. Returns duration_ms
 *                 + the new row count. Auth is the standard /api/* API key.
 *
 * GET  /status  — returns { last_refresh_at, age_seconds, row_count } for the
 *                 /internal/data-quality staleness panel (Deliverable 5).
 *                 Also exposed via a proxy from apps/web.
 *
 * Parent: QUA-506 D3.
 *
 * The refresh runs CONCURRENTLY so concurrent /search readers are never
 * blocked — see docs/benchmarks/qua-506/README.md §5.4 for the empirical
 * verification (0.52x p95 ratio, no blocking observed). First-refresh
 * after a fresh migration is handled inline in the migration file
 * (`REFRESH MATERIALIZED VIEW things_search` without CONCURRENTLY), so by
 * the time this endpoint is called the MV is always populated.
 */

import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { logger as rootLogger } from "../../logger.js";

const logger = rootLogger.child({ route: "things-search-refresh" });

// ---- Raw SQL row types ----
//
// Both row types carry an index signature for compatibility with Drizzle's
// `db.execute()` return shape (`RowList<Record<string, unknown>[]>`), which
// is the same pattern data-quality.ts uses for its inline row casts.

/** Row returned by the post-refresh row-count + size query. */
interface RefreshStatsRow {
  row_count: string;
  total_bytes: string;
  [key: string]: unknown;
}

/** Row returned by the pg_stat_all_tables status query. */
interface StatusRow {
  last_analyzed: string | Date | null;
  row_count: string;
  total_bytes: string;
  [key: string]: unknown;
}

// The refresh endpoint has no request body and no query params; the only
// work is the REFRESH statement itself. We hold the route app in a const
// so it exports as a proper Hono RPC typed route.
const app = new Hono()
  .post("/refresh", async (c) => {
    const db = getDrizzleDb();

    const start = Date.now();
    try {
      // CONCURRENTLY: never blocks readers, requires the UNIQUE index on
      // things_search.id (created in migration 0181). Postgres will ERROR
      // here if the MV is empty — but the migration's initial populate
      // handles that case, so by the time this endpoint fires in
      // production the MV is always populated.
      await db.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY things_search`);

      const durationMs = Date.now() - start;

      // Fetch the new row count + size for observability. Cheap — single
      // index-only count.
      const statsRows = (await db.execute(sql`
        SELECT
          (SELECT COUNT(*) FROM things_search)::bigint AS row_count,
          pg_total_relation_size('things_search')::bigint AS total_bytes
      `)) as Array<RefreshStatsRow>;
      const stats = statsRows[0];

      logger.info(
        {
          event: "refresh_success",
          durationMs,
          rowCount: stats?.row_count,
          totalBytes: stats?.total_bytes,
        },
        "things_search refreshed",
      );

      return c.json({
        success: true as const,
        durationMs,
        rowCount: stats ? Number(stats.row_count) : null,
        totalBytes: stats ? Number(stats.total_bytes) : null,
      });
    } catch (e) {
      const durationMs = Date.now() - start;
      const message = e instanceof Error ? e.message : String(e);
      logger.error(
        { event: "refresh_failed", durationMs, error: message },
        "things_search refresh failed",
      );
      return c.json(
        {
          success: false as const,
          durationMs,
          error: message,
        },
        500,
      );
    }
  })
  .get("/status", async (c) => {
    const db = getDrizzleDb();

    try {
      // pg_stat_all_tables.last_vacuum / last_autovacuum / n_live_tup are
      // the usual signals for MV freshness on postgres. For a materialized
      // view, the "last refresh" stat is exposed as `pg_stat_all_tables`
      // entry for the MV (REFRESH is implemented as a bulk write). We
      // read last_analyze for recency (ANALYZE is run after each refresh
      // from the groundskeeper-driven path — see autoanalyze tuning).
      //
      // Fallback: if last_analyze is NULL, use the newest updated_at in
      // the MV itself as a floor estimate.
      const statusRows = (await db.execute(sql`
        SELECT
          COALESCE(last_analyze, last_autoanalyze) AS last_analyzed,
          n_live_tup::bigint AS row_count,
          pg_total_relation_size('things_search')::bigint AS total_bytes
        FROM pg_stat_all_tables
        WHERE relname = 'things_search'
          AND schemaname = 'public'
      `)) as Array<StatusRow>;
      const row = statusRows[0];

      if (!row) {
        return c.json(
          {
            present: false as const,
            reason:
              "pg_stat_all_tables has no entry for things_search — MV may not exist yet",
          },
          200,
        );
      }

      const lastRefreshedAt =
        row.last_analyzed instanceof Date
          ? row.last_analyzed.toISOString()
          : row.last_analyzed;

      const ageSeconds = lastRefreshedAt
        ? Math.max(
            0,
            Math.round(
              (Date.now() - new Date(lastRefreshedAt).getTime()) / 1000,
            ),
          )
        : null;

      return c.json({
        present: true as const,
        lastRefreshedAt,
        ageSeconds,
        rowCount: Number(row.row_count),
        totalBytes: Number(row.total_bytes),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.warn(
        { event: "status_failed", error: message },
        "things_search status query failed",
      );
      return c.json(
        {
          present: false as const,
          reason: message,
        },
        500,
      );
    }
  });

export const thingsSearchRefreshRoute = app;
export type ThingsSearchRefreshRoute = typeof app;
