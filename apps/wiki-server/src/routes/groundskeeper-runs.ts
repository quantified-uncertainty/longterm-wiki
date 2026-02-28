import { Hono } from "hono";
import { eq, desc, and, sql, gte } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { groundskeeperRuns } from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  firstOrThrow,
} from "./utils.js";
import {
  RecordGroundskeeperRunSchema,
  RecordGroundskeeperRunBatchSchema,
} from "../api-types.js";

const groundskeeperRunsApp = new Hono()
  // ---- POST / (record a single run) ----
  .post("/", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = RecordGroundskeeperRunSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const d = parsed.data;
    const db = getDrizzleDb();

    const inserted = await db
      .insert(groundskeeperRuns)
      .values({
        taskName: d.taskName,
        event: d.event,
        success: d.success,
        durationMs: d.durationMs ?? null,
        summary: d.summary ?? null,
        errorMessage: d.errorMessage ?? null,
        consecutiveFailures: d.consecutiveFailures ?? null,
        circuitBreakerActive: d.circuitBreakerActive ?? false,
        metadata: d.metadata ?? null,
        timestamp: d.timestamp ? new Date(d.timestamp) : new Date(),
      })
      .returning();

    return c.json(firstOrThrow(inserted, "groundskeeper run insert"), 201);
  })

  // ---- POST /batch (record multiple runs) ----
  .post("/batch", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = RecordGroundskeeperRunBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const db = getDrizzleDb();
    const rows = await db
      .insert(groundskeeperRuns)
      .values(
        parsed.data.items.map((d) => ({
          taskName: d.taskName,
          event: d.event,
          success: d.success,
          durationMs: d.durationMs ?? null,
          summary: d.summary ?? null,
          errorMessage: d.errorMessage ?? null,
          consecutiveFailures: d.consecutiveFailures ?? null,
          circuitBreakerActive: d.circuitBreakerActive ?? false,
          metadata: d.metadata ?? null,
          timestamp: d.timestamp ? new Date(d.timestamp) : new Date(),
        }))
      )
      .returning();

    return c.json({ inserted: rows.length }, 201);
  })

  // ---- GET / (list runs) ----
  .get("/", async (c) => {
    const taskName = c.req.query("task");
    const limit = Math.min(Number(c.req.query("limit") || 100), 500);
    const db = getDrizzleDb();

    const conditions = taskName
      ? eq(groundskeeperRuns.taskName, taskName)
      : undefined;

    const rows = await db
      .select()
      .from(groundskeeperRuns)
      .where(conditions)
      .orderBy(desc(groundskeeperRuns.timestamp))
      .limit(limit);

    return c.json({ runs: rows, total: rows.length });
  })

  // ---- GET /stats (aggregate stats per task) ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    // Stats for last 24 hours
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const rows = await db
      .select({
        taskName: groundskeeperRuns.taskName,
        totalRuns: sql<number>`count(*)::int`,
        successCount: sql<number>`count(*) filter (where ${groundskeeperRuns.success} = true)::int`,
        failureCount: sql<number>`count(*) filter (where ${groundskeeperRuns.success} = false)::int`,
        avgDurationMs: sql<number>`avg(${groundskeeperRuns.durationMs})::int`,
        lastRun: sql<string>`max(${groundskeeperRuns.timestamp})`,
        lastSuccess: sql<string>`max(${groundskeeperRuns.timestamp}) filter (where ${groundskeeperRuns.success} = true)`,
      })
      .from(groundskeeperRuns)
      .where(gte(groundskeeperRuns.timestamp, since))
      .groupBy(groundskeeperRuns.taskName);

    // Also get all-time stats
    const allTimeRows = await db
      .select({
        taskName: groundskeeperRuns.taskName,
        totalRuns: sql<number>`count(*)::int`,
        firstRun: sql<string>`min(${groundskeeperRuns.timestamp})`,
      })
      .from(groundskeeperRuns)
      .groupBy(groundskeeperRuns.taskName);

    const allTimeMap = new Map(allTimeRows.map((r) => [r.taskName, r]));

    const stats = rows.map((r) => ({
      taskName: r.taskName,
      last24h: {
        total: r.totalRuns,
        success: r.successCount,
        failure: r.failureCount,
        avgDurationMs: r.avgDurationMs,
        lastRun: r.lastRun,
        lastSuccess: r.lastSuccess,
        successRate:
          r.totalRuns > 0
            ? Math.round((r.successCount / r.totalRuns) * 100)
            : null,
      },
      allTime: {
        total: allTimeMap.get(r.taskName)?.totalRuns ?? 0,
        firstRun: allTimeMap.get(r.taskName)?.firstRun ?? null,
      },
    }));

    return c.json({ stats, since: since.toISOString() });
  });

export const groundskeeperRunsRoute = groundskeeperRunsApp;
export type GroundskeeperRunsRoute = typeof groundskeeperRunsApp;
