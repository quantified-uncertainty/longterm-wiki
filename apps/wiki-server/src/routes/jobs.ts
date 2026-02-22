import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, sql, desc } from "drizzle-orm";
import { getDb, getDrizzleDb } from "../db.js";
import { jobs } from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  notFoundError,
} from "./utils.js";

export const jobsRoute = new Hono();

// ---- Constants ----

const MAX_PAGE_SIZE = 200;
const MAX_BATCH_SIZE = 50;
const STALE_TIMEOUT_MINUTES = 60;

const VALID_STATUSES = [
  "pending",
  "claimed",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

type JobStatus = (typeof VALID_STATUSES)[number];

// ---- Schemas ----

const CreateJobSchema = z.object({
  type: z.string().min(1).max(100),
  params: z.record(z.unknown()).nullable().optional(),
  priority: z.number().int().min(0).max(1000).default(0),
  maxRetries: z.number().int().min(0).max(10).default(3),
});

const CreateBatchSchema = z.array(CreateJobSchema).min(1).max(MAX_BATCH_SIZE);

const ListQuery = z.object({
  status: z.enum(VALID_STATUSES).optional(),
  type: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const ClaimSchema = z.object({
  type: z.string().min(1).max(100).optional(),
  workerId: z.string().min(1).max(200),
});

const CompleteSchema = z.object({
  result: z.record(z.unknown()).nullable().optional(),
});

const FailSchema = z.object({
  error: z.string().max(5000),
});

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

// ---- POST / (create job or batch) ----

jobsRoute.post("/", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const db = getDrizzleDb();

  // Support both single object and array for batch creation
  if (Array.isArray(body)) {
    const parsed = CreateBatchSchema.safeParse(body);
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
  const parsed = ListQuery.safeParse(c.req.query());
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

  const parsed = ClaimSchema.safeParse(body);
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

  const parsed = CompleteSchema.safeParse(body);
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

  const parsed = FailSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const db = getDrizzleDb();

  // First get the current job to check retry count
  const current = await db.select().from(jobs).where(eq(jobs.id, id));
  if (current.length === 0) {
    return notFoundError(c, "Job not found");
  }

  const job = current[0];
  if (job.status !== "running" && job.status !== "claimed") {
    return validationError(
      c,
      `Job is in '${job.status}' status, expected 'running' or 'claimed'`
    );
  }

  const newRetries = job.retries + 1;
  const shouldRetry = newRetries < job.maxRetries;

  const rows = await db
    .update(jobs)
    .set({
      status: shouldRetry ? ("pending" as JobStatus) : ("failed" as JobStatus),
      error: parsed.data.error,
      retries: newRetries,
      completedAt: shouldRetry ? null : new Date(),
      // Reset claim fields for retry
      ...(shouldRetry
        ? { claimedAt: null, startedAt: null, workerId: null }
        : {}),
    })
    .where(eq(jobs.id, id))
    .returning();

  return c.json({ ...formatJob(rows[0]), retried: shouldRetry });
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

const SweepSchema = z.object({
  timeoutMinutes: z.number().int().min(1).max(10080).default(STALE_TIMEOUT_MINUTES),
});

jobsRoute.post("/sweep", async (c) => {
  const body = (await parseJsonBody(c)) ?? {};
  const parsed = SweepSchema.safeParse(body);
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
