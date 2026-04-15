// QUA-506 D3: POST /refresh + GET /status for the things_search MV.

import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { logger as rootLogger } from "../../logger.js";

const logger = rootLogger.child({ route: "things-search-refresh" });

// Drizzle wraps postgres.js errors in DrizzleQueryError whose top-level
// message is `Failed query: <sql>\nparams: ...`. The real postgres error
// (incl. timeout / deadlock / lock_timeout context) sits on .cause. Walk it
// so logs and Discord alerts show the actionable reason.
function unwrapError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message) return cause.message;
  return e.message;
}

const app = new Hono()
  .post("/refresh", async (c) => {
    const db = getDrizzleDb();

    const start = Date.now();
    try {
      // Wrap REFRESH + ANALYZE in a transaction so they're atomic: if
      // ANALYZE fails the MV rolls back to the previous snapshot, keeping
      // last_analyze (the staleness signal) in sync with the data on disk.
      // SET LOCAL statement_timeout raises the app pool's 30s ceiling —
      // benchmark observed REFRESH up to 29s, we need headroom for bad
      // managed-pg days.
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '180000'`);
        await tx.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY things_search`);
        await tx.execute(sql`ANALYZE things_search`);
      });

      const durationMs = Date.now() - start;

      const statsRows = (await db.execute(sql`
        SELECT
          reltuples::bigint AS row_count,
          pg_total_relation_size(oid)::bigint AS total_bytes
        FROM pg_class
        WHERE relname = 'things_search'
          AND relnamespace = 'public'::regnamespace
      `)) as Array<{ row_count: string; total_bytes: string }>;
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
      const message = unwrapError(e);
      logger.error(
        {
          event: "refresh_failed",
          durationMs,
          error: message,
          wrapped: e instanceof Error ? e.message : undefined,
        },
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
      const statusRows = (await db.execute(sql`
        SELECT
          COALESCE(s.last_analyze, s.last_autoanalyze) AS last_analyzed,
          c.reltuples::bigint AS row_count,
          pg_total_relation_size(c.oid)::bigint AS total_bytes
        FROM pg_stat_all_tables s
        JOIN pg_class c
          ON c.relname = s.relname
         AND c.relnamespace = 'public'::regnamespace
        WHERE s.relname = 'things_search'
          AND s.schemaname = 'public'
      `)) as Array<{
        last_analyzed: string | Date | null;
        row_count: string;
        total_bytes: string;
      }>;
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
      const message = unwrapError(e);
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
