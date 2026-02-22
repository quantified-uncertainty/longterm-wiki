import { Hono } from "hono";
import { eq, and, count, sql, desc } from "drizzle-orm";
import { getDb, getDrizzleDb } from "../db.js";
import { jobs } from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  notFoundError,
} from "./utils.js";
import {
  CreateJobSchema,
  CreateJobBatchSchema,
  ListJobsQuerySchema,
  ClaimJobSchema,
  CompleteJobSchema,
  FailJobSchema,
  SweepJobsSchema,
  type JobStatus,
} from "../api-types.js";

export const jobsRoute = new Hono();

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
  };
}

// ---- POST / (create job or batch) ----

jobsRoute.post("/", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const db = getDrizzleDb();

  // Support both single object and array for batch creation
  if (Array.isArray(body)) {
    const parsed = CreateJobBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const rows = await db
      .insert(jobs)
      .values(
        parsed.data.map((j) => ({
          type: j.type,
          params: j.params ?? null,
          priority: j.priority,
          maxRetries: j.maxRetries,
        }))
      )
      .returning();

    return c.json(rows.map(formatJob), 201);
  }

  const parsed = CreateJobSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const d = parsed.data;
  const rows = await db
    .insert(jobs)
    .values({
      type: d.type,
      params: d.params ?? null,
      priority: d.priority,
      maxRetries: d.maxRetries,
    })
    .returning();

  return c.json(formatJob(rows[0]), 201);
});

// ---- GET / (list jobs with filters) ----

jobsRoute.get("/", async (c) => {
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
});

// ---- POST /claim (atomically claim next pending job) ----

jobsRoute.post("/claim", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = ClaimJobSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { type, workerId } = parsed.data;
  const pgClient = getDb();

  // Use raw SQL for SELECT FOR UPDATE SKIP LOCKED (atomic claim).
  // Two query variants to keep parameterization clean.
  const result = type
    ? await pgClient.unsafe(
        `UPDATE "jobs"
         SET status = 'claimed', claimed_at = now(), worker_id = $1
         WHERE id = (
           SELECT id FROM "jobs"
           WHERE status = 'pending' AND "type" = $2
           ORDER BY priority DESC, created_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [workerId, type]
      )
    : await pgClient.unsafe(
        `UPDATE "jobs"
         SET status = 'claimed', claimed_at = now(), worker_id = $1
         WHERE id = (
           SELECT id FROM "jobs"
           WHERE status = 'pending'
           ORDER BY priority DESC, created_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [workerId]
      );

  if (result.length === 0) {
    return c.json({ job: null }, 200);
  }

  const row = result[0] as Record<string, unknown>;
  return c.json({
    job: {
      id: row.id,
      type: row.type,
      status: row.status,
      params: row.params,
      priority: row.priority,
      retries: row.retries,
      maxRetries: row.max_retries,
      createdAt: row.created_at,
      claimedAt: row.claimed_at,
      workerId: row.worker_id,
    },
  });
});

// ---- POST /:id/start (mark as running) ----

jobsRoute.post("/:id/start", async (c) => {
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
});

// ---- POST /:id/complete (mark as completed with result) ----

jobsRoute.post("/:id/complete", async (c) => {
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
    })
    .where(and(eq(jobs.id, id), eq(jobs.status, "running")))
    .returning();

  if (rows.length === 0) {
    return notFoundError(c, "Job not found or not in 'running' status");
  }

  return c.json(formatJob(rows[0]));
});

// ---- POST /:id/fail (mark as failed; auto-retry if under max) ----

jobsRoute.post("/:id/fail", async (c) => {
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
  const result = await pgClient.unsafe(
    `UPDATE "jobs"
     SET
       retries      = retries + 1,
       status       = CASE WHEN (retries + 1) < max_retries THEN 'pending' ELSE 'failed' END,
       error        = $1,
       completed_at = CASE WHEN (retries + 1) < max_retries THEN NULL ELSE now() END,
       claimed_at   = CASE WHEN (retries + 1) < max_retries THEN NULL ELSE claimed_at END,
       started_at   = CASE WHEN (retries + 1) < max_retries THEN NULL ELSE started_at END,
       worker_id    = CASE WHEN (retries + 1) < max_retries THEN NULL ELSE worker_id END
     WHERE id = $2
       AND status IN ('running', 'claimed')
     RETURNING *`,
    [parsed.data.error, id]
  );

  if (result.length === 0) {
    // Distinguish "not found" from "wrong status" for accurate error messages.
    const db = getDrizzleDb();
    const exists = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.id, id));
    if (exists.length === 0) {
      return notFoundError(c, "Job not found");
    }
    return validationError(
      c,
      "Job is not in 'running' or 'claimed' status"
    );
  }

  const row = result[0] as Record<string, unknown>;
  // `retried` is derived from the post-update status returned by RETURNING *.
  const retried = row.status === "pending";

  return c.json({ ...formatRawJobRow(row), retried });
});

// ---- POST /:id/cancel (cancel a pending or claimed job) ----

jobsRoute.post("/:id/cancel", async (c) => {
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
});

// ---- GET /stats (aggregate counts by type and status) ----

jobsRoute.get("/stats", async (c) => {
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
});

// ---- POST /sweep (reset stale claimed/running jobs) ----

jobsRoute.post("/sweep", async (c) => {
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
        sql`${jobs.claimedAt} < now() - interval '${sql.raw(String(timeoutMinutes))} minutes'`
      )
    )
    .returning({ id: jobs.id, type: jobs.type });

  return c.json({
    swept: result.length,
    jobs: result,
  });
});

// ---- GET /:id (single job details) ----

jobsRoute.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return validationError(c, "id must be a number");

  const db = getDrizzleDb();

  const rows = await db.select().from(jobs).where(eq(jobs.id, id));

  if (rows.length === 0) {
    return notFoundError(c, "Job not found");
  }

  return c.json(formatJob(rows[0]));
});
