import { Hono } from "hono";
import { eq, and, count, sql, desc } from "drizzle-orm";
import { getDb, getDrizzleDb } from "../../db.js";
import { jobs } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  notFoundError,
  firstOrThrow,
} from "../shared/utils.js";
import {
  CreateJobSchema,
  CreateJobBatchSchema,
  ListJobsQuerySchema,
  ClaimJobSchema,
  CompleteJobSchema,
  FailJobSchema,
  SweepJobsSchema,
  type JobStatus,
} from "../../api-types.js";

// ---- Helpers ----

function formatJob(row: typeof jobs.$inferSelect) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    params: row.params,
    result: row.result,
    error: row.error,
    priority: row.priority,
    retries: row.retries,
    maxRetries: row.maxRetries,
    createdAt: row.createdAt,
    claimedAt: row.claimedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    workerId: row.workerId,
    runAfter: row.runAfter,
    dedupKey: row.dedupKey,
    parentJobId: row.parentJobId,
    costUsd: row.costUsd,
  };
}

/** Format a raw postgres row (snake_case columns) into the same shape as `formatJob`. */
function formatRawJobRow(row: Record<string, unknown>) {
  return {
    id: row.id as number,
    type: row.type as string,
    status: row.status as string,
    params: row.params as Record<string, unknown> | null,
    result: row.result as Record<string, unknown> | null,
    error: row.error as string | null,
    priority: row.priority as number,
    retries: row.retries as number,
    maxRetries: row.max_retries as number,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    workerId: row.worker_id as string | null,
    runAfter: row.run_after,
    dedupKey: row.dedup_key as string | null,
    parentJobId: row.parent_job_id as number | null,
    costUsd: row.cost_usd as string | null,
  };
}

const jobsApp = new Hono()

  // ---- POST / (create job or batch) ----

  .post("/", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const db = getDrizzleDb();

    // Support both single object and array for batch creation
    if (Array.isArray(body)) {
      const parsed = CreateJobBatchSchema.safeParse(body);
      if (!parsed.success) return validationError(c, parsed.error.message);

      // Dedup key handling is not supported in batch creation
      if (parsed.data.some((j) => j.dedupKey)) {
        return validationError(c, "dedupKey is not supported in batch creation; use single-job creation instead");
      }

      const rows = await db
        .insert(jobs)
        .values(
          parsed.data.map((j) => ({
            type: j.type,
            params: j.params ?? null,
            priority: j.priority,
            maxRetries: j.maxRetries,
            dedupKey: j.dedupKey ?? null,
            parentJobId: j.parentJobId ?? null,
            runAfter: j.runAfter ? new Date(j.runAfter) : null,
          }))
        )
        .returning();

      return c.json(rows.map(formatJob), 201);
    }

    const parsed = CreateJobSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const d = parsed.data;

    // If dedupKey is provided, use INSERT ... ON CONFLICT to avoid duplicates
    // among active jobs (pending/claimed/running).
    if (d.dedupKey) {
      const pgClient = getDb();
      const insertResult = await pgClient.unsafe(
        `INSERT INTO "jobs" (type, params, priority, max_retries, dedup_key, parent_job_id, run_after)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL AND status IN ('pending', 'claimed', 'running')
         DO NOTHING
         RETURNING *`,
        [
          d.type,
          d.params ? JSON.stringify(d.params) : null,
          d.priority,
          d.maxRetries,
          d.dedupKey,
          d.parentJobId ?? null,
          d.runAfter ?? null,
        ]
      );

      if (insertResult.length > 0) {
        return c.json(
          { ...formatRawJobRow(insertResult[0] as Record<string, unknown>), dedupExisting: false },
          201
        );
      }

      // Insert returned 0 rows — an active job with this dedup key exists.
      const existing = await pgClient.unsafe(
        `SELECT * FROM "jobs"
         WHERE dedup_key = $1 AND status IN ('pending', 'claimed', 'running')
         LIMIT 1`,
        [d.dedupKey]
      );

      if (existing.length > 0) {
        return c.json(
          { ...formatRawJobRow(existing[0] as Record<string, unknown>), dedupExisting: true },
          200
        );
      }

      // Race condition: the conflicting job completed between INSERT and SELECT.
      // Retry the insert once without ON CONFLICT since no active duplicate exists.
      const retryResult = await pgClient.unsafe(
        `INSERT INTO "jobs" (type, params, priority, max_retries, dedup_key, parent_job_id, run_after)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL AND status IN ('pending', 'claimed', 'running')
         DO NOTHING
         RETURNING *`,
        [
          d.type,
          d.params ? JSON.stringify(d.params) : null,
          d.priority,
          d.maxRetries,
          d.dedupKey,
          d.parentJobId ?? null,
          d.runAfter ?? null,
        ]
      );

      if (retryResult.length > 0) {
        return c.json(
          { ...formatRawJobRow(retryResult[0] as Record<string, unknown>), dedupExisting: false },
          201
        );
      }

      // Still conflicting — return the existing active job
      const existingRetry = await pgClient.unsafe(
        `SELECT * FROM "jobs"
         WHERE dedup_key = $1 AND status IN ('pending', 'claimed', 'running')
         LIMIT 1`,
        [d.dedupKey]
      );

      if (existingRetry.length > 0) {
        return c.json(
          { ...formatRawJobRow(existingRetry[0] as Record<string, unknown>), dedupExisting: true },
          200
        );
      }

      // Extreme race: conflicting job completed between both attempts.
      // The dedup conflict is gone, so just insert normally.
      const finalRows = await db
        .insert(jobs)
        .values({
          type: d.type,
          params: d.params ?? null,
          priority: d.priority,
          maxRetries: d.maxRetries,
          dedupKey: d.dedupKey ?? null,
          parentJobId: d.parentJobId ?? null,
          runAfter: d.runAfter ? new Date(d.runAfter) : null,
        })
        .returning();

      return c.json(formatJob(firstOrThrow(finalRows, "dedup fallback insert")), 201);
    }

    const rows = await db
      .insert(jobs)
      .values({
        type: d.type,
        params: d.params ?? null,
        priority: d.priority,
        maxRetries: d.maxRetries,
        parentJobId: d.parentJobId ?? null,
        runAfter: d.runAfter ? new Date(d.runAfter) : null,
      })
      .returning();

    return c.json(formatJob(firstOrThrow(rows, "job insert")), 201);
  })

  // ---- GET / (list jobs with filters) ----

  .get("/", async (c) => {
    const parsed = ListJobsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { status, type, limit, offset } = parsed.data;
    const db = getDrizzleDb();

    const conditions = [];
    if (status) conditions.push(eq(jobs.status, status));
    if (type) conditions.push(eq(jobs.type, type));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, countResult] = await Promise.all([
      db
        .select()
        .from(jobs)
        .where(whereClause)
        .orderBy(desc(jobs.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(jobs).where(whereClause),
    ]);

    return c.json({
      entries: rows.map(formatJob),
      total: countResult[0].count,
      limit,
      offset,
    });
  })

  // ---- POST /claim (atomically claim next pending job) ----

  .post("/claim", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = ClaimJobSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { type, types, workerId } = parsed.data;
    const pgClient = getDb();

    // Use raw SQL for SELECT FOR UPDATE SKIP LOCKED (atomic claim).
    // Three query variants to keep parameterization clean:
    //   1. types array — filter by ANY($2::text[])
    //   2. single type — filter by exact match
    //   3. no type filter — claim any pending job
    // All variants respect the run_after column (delayed execution).
    const runAfterClause = `AND (run_after IS NULL OR run_after <= now())`;

    let result;
    if (types && types.length > 0) {
      result = await pgClient.unsafe(
        `UPDATE "jobs"
         SET status = 'claimed', claimed_at = now(), worker_id = $1
         WHERE id = (
           SELECT id FROM "jobs"
           WHERE status = 'pending' AND "type" = ANY($2::text[])
           ${runAfterClause}
           ORDER BY priority DESC, created_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [workerId, types]
      );
    } else if (type) {
      result = await pgClient.unsafe(
        `UPDATE "jobs"
         SET status = 'claimed', claimed_at = now(), worker_id = $1
         WHERE id = (
           SELECT id FROM "jobs"
           WHERE status = 'pending' AND "type" = $2
           ${runAfterClause}
           ORDER BY priority DESC, created_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [workerId, type]
      );
    } else {
      result = await pgClient.unsafe(
        `UPDATE "jobs"
         SET status = 'claimed', claimed_at = now(), worker_id = $1
         WHERE id = (
           SELECT id FROM "jobs"
           WHERE status = 'pending'
           ${runAfterClause}
           ORDER BY priority DESC, created_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [workerId]
      );
    }

    if (result.length === 0) {
      return c.json({ job: null }, 200);
    }

    return c.json({ job: formatRawJobRow(result[0] as Record<string, unknown>) });
  })

  // ---- POST /:id/start (mark as running) ----

  .post("/:id/start", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return validationError(c, "id must be a number");

    const db = getDrizzleDb();

    const rows = await db
      .update(jobs)
      .set({ status: "running" as JobStatus, startedAt: new Date() })
      .where(and(eq(jobs.id, id), eq(jobs.status, "claimed")))
      .returning();

    if (rows.length === 0) {
      return notFoundError(c, "Job not found or not in 'claimed' status");
    }

    return c.json(formatJob(rows[0]));
  })

  // ---- POST /:id/complete (mark as completed with result) ----

  .post("/:id/complete", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return validationError(c, "id must be a number");

    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = CompleteJobSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const db = getDrizzleDb();

    const rows = await db
      .update(jobs)
      .set({
        status: "completed" as JobStatus,
        result: parsed.data.result ?? null,
        completedAt: new Date(),
        ...(parsed.data.cost != null
          ? { costUsd: String(parsed.data.cost) }
          : {}),
      })
      .where(and(eq(jobs.id, id), eq(jobs.status, "running")))
      .returning();

    if (rows.length === 0) {
      return notFoundError(c, "Job not found or not in 'running' status");
    }

    return c.json(formatJob(rows[0]));
  })

  // ---- POST /:id/fail (mark as failed; auto-retry if under max) ----

  .post("/:id/fail", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return validationError(c, "id must be a number");

    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = FailJobSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const pgClient = getDb();

    // Single atomic UPDATE avoids the TOCTOU race between SELECT and UPDATE.
    // The WHERE clause acts as an optimistic lock: only rows in 'running' or
    // 'claimed' status are updated, and retries/max_retries are read and written
    // in the same statement, so concurrent calls cannot double-increment retries.
    //
    // PostgreSQL evaluates all SET expressions against the *pre-update* row values,
    // so `retries + 1` in each CASE expression is consistent (it always means
    // old_retries + 1, not the value written by `retries = retries + 1`).
    //
    // Note: `error = $1` is always written, even on retry (same as the previous
    // two-query implementation). A retried job carries the last failure's error
    // message until it completes or fails permanently.
    //
    // Exponential backoff: run_after = now() + (2^retries * 30s) when retrying.
    // `retries` in `power(2, retries)` is the pre-increment value (i.e., attempt 0
    // yields 30s delay, attempt 1 yields 60s, attempt 2 yields 120s, etc.).
    const result = await pgClient.unsafe(
      `UPDATE "jobs"
     SET
       retries      = retries + 1,
       status       = CASE WHEN (retries + 1) < max_retries THEN 'pending' ELSE 'failed' END,
       error        = $1,
       completed_at = CASE WHEN (retries + 1) < max_retries THEN NULL ELSE now() END,
       claimed_at   = CASE WHEN (retries + 1) < max_retries THEN NULL ELSE claimed_at END,
       started_at   = CASE WHEN (retries + 1) < max_retries THEN NULL ELSE started_at END,
       worker_id    = CASE WHEN (retries + 1) < max_retries THEN NULL ELSE worker_id END,
       run_after    = CASE WHEN (retries + 1) < max_retries THEN now() + (power(2, retries) * interval '30 seconds') ELSE run_after END
     WHERE id = $2
       AND status IN ('running', 'claimed')
     RETURNING *`,
      [parsed.data.error, id]
    );

    if (result.length === 0) {
      // Distinguish "not found" from "wrong status" for accurate error messages.
      const db = getDrizzleDb();
      const exists = await db
        .select({ id: jobs.id, status: jobs.status })
        .from(jobs)
        .where(eq(jobs.id, id));
      if (exists.length === 0) {
        return notFoundError(c, "Job not found");
      }
      return validationError(
        c,
        `Job is in '${exists[0].status}' status, expected 'running' or 'claimed'`
      );
    }

    const row = result[0] as Record<string, unknown>;
    // `retried` is derived from the post-update status returned by RETURNING *.
    const retried = row.status === "pending";

    return c.json({ ...formatRawJobRow(row), retried });
  })

  // ---- POST /:id/cancel (cancel a pending or claimed job) ----

  .post("/:id/cancel", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return validationError(c, "id must be a number");

    const db = getDrizzleDb();

    const rows = await db
      .update(jobs)
      .set({
        status: "cancelled" as JobStatus,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(jobs.id, id),
          sql`${jobs.status} IN ('pending', 'claimed')`
        )
      )
      .returning();

    if (rows.length === 0) {
      return notFoundError(
        c,
        "Job not found or not in 'pending'/'claimed' status"
      );
    }

    return c.json(formatJob(rows[0]));
  })

  // ---- GET /stats (aggregate counts by type and status) ----

  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const byTypeStatus = await db
      .select({
        type: jobs.type,
        status: jobs.status,
        count: count(),
      })
      .from(jobs)
      .groupBy(jobs.type, jobs.status);

    // Compute average duration for completed jobs
    const avgDuration = await db
      .select({
        type: jobs.type,
        avgMs: sql<number>`avg(extract(epoch from (${jobs.completedAt} - ${jobs.startedAt})) * 1000)`,
      })
      .from(jobs)
      .where(
        and(
          eq(jobs.status, "completed"),
          sql`${jobs.startedAt} IS NOT NULL`,
          sql`${jobs.completedAt} IS NOT NULL`
        )
      )
      .groupBy(jobs.type);

    // Failure rate per type
    const failureRate = await db
      .select({
        type: jobs.type,
        total: count(),
        failed: sql<number>`sum(case when ${jobs.status} = 'failed' then 1 else 0 end)`,
      })
      .from(jobs)
      .where(sql`${jobs.status} IN ('completed', 'failed')`)
      .groupBy(jobs.type);

    // Build summary
    const typeSummary: Record<
      string,
      { byStatus: Record<string, number>; avgDurationMs?: number; failureRate?: number }
    > = {};

    for (const row of byTypeStatus) {
      if (!typeSummary[row.type]) {
        typeSummary[row.type] = { byStatus: {} };
      }
      typeSummary[row.type].byStatus[row.status] = row.count;
    }

    for (const row of avgDuration) {
      if (typeSummary[row.type]) {
        typeSummary[row.type].avgDurationMs = Math.round(Number(row.avgMs));
      }
    }

    for (const row of failureRate) {
      if (typeSummary[row.type] && row.total > 0) {
        typeSummary[row.type].failureRate = Number(row.failed) / row.total;
      }
    }

    const totalResult = await db.select({ count: count() }).from(jobs);

    return c.json({
      totalJobs: totalResult[0].count,
      byType: typeSummary,
    });
  })

  // ---- POST /sweep (reset stale claimed/running jobs) ----

  .post("/sweep", async (c) => {
    const body = (await parseJsonBody(c)) ?? {};
    const parsed = SweepJobsSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);
    const timeoutMinutes = parsed.data.timeoutMinutes;

    const db = getDrizzleDb();

    const result = await db
      .update(jobs)
      .set({
        status: "pending" as JobStatus,
        claimedAt: null,
        startedAt: null,
        workerId: null,
      })
      .where(
        and(
          sql`${jobs.status} IN ('claimed', 'running')`,
          sql`${jobs.claimedAt} < now() - (${timeoutMinutes} * interval '1 minute')`
        )
      )
      .returning({ id: jobs.id, type: jobs.type });

    return c.json({
      swept: result.length,
      jobs: result,
    });
  })

  // ---- GET /:id/children (child job status summary) ----

  .get("/:id/children", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return validationError(c, "id must be a number");

    const pgClient = getDb();

    interface ChildStatusRow {
      status: string;
      count: number;
    }

    const rows = (await pgClient.unsafe(
      `SELECT status, count(*)::int as count FROM jobs WHERE parent_job_id = $1 GROUP BY status`,
      [id]
    )) as ChildStatusRow[];

    const summary: Record<string, number> = {};
    for (const row of rows) {
      summary[row.status] = row.count;
    }

    return c.json({
      parentJobId: id,
      children: summary,
      total: rows.reduce((sum, r) => sum + r.count, 0),
    });
  })

  // ---- GET /:id (single job details) ----

  .get("/:id", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return validationError(c, "id must be a number");

    const db = getDrizzleDb();

    const rows = await db.select().from(jobs).where(eq(jobs.id, id));

    if (rows.length === 0) {
      return notFoundError(c, "Job not found");
    }

    return c.json(formatJob(rows[0]));
  });

export const jobsRoute = jobsApp;
export type JobsRoute = typeof jobsApp;
