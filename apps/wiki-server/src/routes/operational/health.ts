import { Hono } from "hono";
import { count } from "drizzle-orm";
import { getDrizzleDb, getDb } from "../../db.js";
import { entityIds, wikiPages, entities, facts } from "../../schema.js";
import { logger } from "../../logger.js";
import { verifyToken } from "../../auth.js";
import { getMigrationError } from "../../migration-state.js";

const startTime = Date.now();

const healthApp = new Hono()
  .get("/", async (c) => {
    const migrationError = getMigrationError();
    const db = getDrizzleDb();

    let dbStatus = "ok";
    let totalIds = 0;
    let nextId = 0;
    let totalPages = 0;
    let totalEntities = 0;
    let totalFacts = 0;

    try {
      const countResult = await db.select({ count: count() }).from(entityIds);
      totalIds = countResult[0].count;

      const pagesCountResult = await db
        .select({ count: count() })
        .from(wikiPages);
      totalPages = pagesCountResult[0].count;

      const entitiesCountResult = await db
        .select({ count: count() })
        .from(entities);
      totalEntities = entitiesCountResult[0].count;

      const factsCountResult = await db.select({ count: count() }).from(facts);
      totalFacts = factsCountResult[0].count;

      // Sequence query — no Drizzle equivalent, use raw SQL
      const rawDb = getDb();
      const seqResult =
        await rawDb`SELECT last_value, is_called FROM entity_id_seq`;
      const lastValue = Number(seqResult[0].last_value);
      const isCalled = seqResult[0].is_called;
      // If is_called is false, nextval will return last_value itself
      nextId = isCalled ? lastValue + 1 : lastValue;
    } catch (err) {
      dbStatus = "error";
      logger.error({ err }, "Health check DB error");
    }

    // Job queue health — separate try/catch so a failure here does NOT
    // degrade the core health status (which gates deploy smoke tests).
    let pendingJobs = 0;
    let oldestPendingJobAgeSeconds: number | null = null;
    try {
      const rawDb = getDb();
      interface PendingJobsRow {
        pending_count: number;
        oldest_pending_age_seconds: number | null;
      }
      const pendingResult = await rawDb<PendingJobsRow[]>`
        SELECT
          count(*)::int AS pending_count,
          EXTRACT(EPOCH FROM (now() - min(created_at)))::int AS oldest_pending_age_seconds
        FROM jobs
        WHERE status = 'pending'
      `;
      pendingJobs = pendingResult[0]?.pending_count ?? 0;
      oldestPendingJobAgeSeconds =
        pendingResult[0]?.oldest_pending_age_seconds ?? null;
    } catch (err) {
      // Best-effort: job queue data is informational, not critical.
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Health check: failed to query job queue stats",
      );
    }

    // Degraded if migration failed at startup OR DB queries are failing.
    // The post-deploy smoke test checks for status === "healthy", so a degraded
    // server will correctly fail the smoke test and trigger investigation.
    const isDegraded = migrationError !== null || dbStatus !== "ok";

    return c.json({
      status: isDegraded ? "degraded" : "healthy",
      database: dbStatus,
      // Only expose that a migration failed, not the raw error message.
      // Raw errors may contain table names, SQL fragments, or literal values.
      // Full details are in the server logs (logger.error in index.ts).
      ...(migrationError ? { migrationError: "migration_failed" } : {}),
      totalIds,
      totalPages,
      totalEntities,
      totalFacts,
      nextId,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      pendingJobs,
      oldestPendingJobAgeSeconds,
    });
  })
  /**
   * GET /migrations — Migration status for post-deploy checks.
   * Returns the count and latest timestamp from drizzle.__drizzle_migrations.
   * CI compares latestCreatedAt against the journal's last entry to confirm
   * all migrations were applied. Requires Bearer auth.
   */
  .get("/migrations", async (c) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Bearer token required" }, 401);
    }
    const token = authHeader.slice(7);
    const expectedKey = process.env.LONGTERMWIKI_SERVER_API_KEY;
    if (expectedKey && !verifyToken(token, expectedKey)) {
      return c.json({ error: "Invalid API key" }, 401);
    }

    try {
      const rawDb = getDb();
      interface MigrationRow {
        applied_count: number;
        latest_created_at: string | null;
      }
      const result = await rawDb<MigrationRow[]>`
        SELECT
          count(*)::int AS applied_count,
          max(created_at)::text AS latest_created_at
        FROM drizzle.__drizzle_migrations
      `;
      return c.json({
        appliedCount: result[0].applied_count,
        latestCreatedAt: result[0].latest_created_at,
      });
    } catch (err) {
      logger.error({ err }, "Migration status check failed");
      return c.json({ error: "Failed to query migration status" }, 500);
    }
  })
  /**
   * GET /auth — Check if a Bearer token is valid.
   * Returns 401 if no token or invalid token.
   */
  .get("/auth", (c) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Bearer token required" }, 401);
    }

    const token = authHeader.slice(7);
    const expectedKey = process.env.LONGTERMWIKI_SERVER_API_KEY;

    if (!expectedKey) {
      return c.json({ valid: true, keyConfigured: false });
    }

    if (!verifyToken(token, expectedKey)) {
      return c.json({ error: "Invalid API key" }, 401);
    }

    return c.json({ valid: true, keyConfigured: true });
  });

export const healthRoute = healthApp;
export type HealthRoute = typeof healthApp;
