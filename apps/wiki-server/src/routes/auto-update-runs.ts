import { Hono } from "hono";
import { z } from "zod";
import { eq, count, sql, desc } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { autoUpdateRuns, autoUpdateResults } from "../schema.js";
import { parseJsonBody, validationError, invalidJsonError, notFoundError, firstOrThrow } from "./utils.js";

export const autoUpdateRunsRoute = new Hono();

// ---- Constants ----

const MAX_BATCH_SIZE = 100;
const MAX_PAGE_SIZE = 200;

const VALID_TRIGGERS = ["scheduled", "manual"] as const;
const VALID_STATUSES = ["success", "failed", "skipped"] as const;

// ---- Schemas ----

const ResultSchema = z.object({
  pageId: z.string().min(1).max(200),
  status: z.enum(VALID_STATUSES),
  tier: z.string().max(50).nullable().optional(),
  durationMs: z.number().int().min(0).nullable().optional(),
  errorMessage: z.string().max(5000).nullable().optional(),
});

const RecordRunSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable().optional(),
  trigger: z.enum(VALID_TRIGGERS),
  budgetLimit: z.number().min(0).nullable().optional(),
  budgetSpent: z.number().min(0).nullable().optional(),
  sourcesChecked: z.number().int().min(0).nullable().optional(),
  sourcesFailed: z.number().int().min(0).nullable().optional(),
  itemsFetched: z.number().int().min(0).nullable().optional(),
  itemsRelevant: z.number().int().min(0).nullable().optional(),
  pagesPlanned: z.number().int().min(0).nullable().optional(),
  pagesUpdated: z.number().int().min(0).nullable().optional(),
  pagesFailed: z.number().int().min(0).nullable().optional(),
  pagesSkipped: z.number().int().min(0).nullable().optional(),
  newPagesCreated: z.array(z.string()).optional(),
  results: z.array(ResultSchema).max(MAX_BATCH_SIZE).optional(),
});

const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Helpers ----

/** Map a run row + its result rows to the API response shape. */
function formatRunEntry(
  r: typeof autoUpdateRuns.$inferSelect,
  results: (typeof autoUpdateResults.$inferSelect)[]
) {
  return {
    id: r.id,
    date: r.date,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    trigger: r.trigger,
    budgetLimit: r.budgetLimit,
    budgetSpent: r.budgetSpent,
    sourcesChecked: r.sourcesChecked,
    sourcesFailed: r.sourcesFailed,
    itemsFetched: r.itemsFetched,
    itemsRelevant: r.itemsRelevant,
    pagesPlanned: r.pagesPlanned,
    pagesUpdated: r.pagesUpdated,
    pagesFailed: r.pagesFailed,
    pagesSkipped: r.pagesSkipped,
    newPagesCreated: r.newPagesCreated
      ? (() => {
          try {
            return JSON.parse(r.newPagesCreated) as string[];
          } catch {
            return [];
          }
        })()
      : [],
    results: results.map((entry) => ({
      pageId: entry.pageId,
      status: entry.status,
      tier: entry.tier,
      durationMs: entry.durationMs,
      errorMessage: entry.errorMessage,
    })),
    createdAt: r.createdAt,
  };
}

// ---- POST / (record a complete run with results) ----

autoUpdateRunsRoute.post("/", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = RecordRunSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const d = parsed.data;
  const db = getDrizzleDb();

  // Use a Drizzle transaction to ensure atomicity of run + results insert
  const result = await db.transaction(async (tx) => {
    const runRow = await tx
      .insert(autoUpdateRuns)
      .values({
        date: d.date,
        startedAt: new Date(d.startedAt),
        completedAt: d.completedAt ? new Date(d.completedAt) : null,
        trigger: d.trigger,
        budgetLimit: d.budgetLimit ?? null,
        budgetSpent: d.budgetSpent ?? null,
        sourcesChecked: d.sourcesChecked ?? null,
        sourcesFailed: d.sourcesFailed ?? null,
        itemsFetched: d.itemsFetched ?? null,
        itemsRelevant: d.itemsRelevant ?? null,
        pagesPlanned: d.pagesPlanned ?? null,
        pagesUpdated: d.pagesUpdated ?? null,
        pagesFailed: d.pagesFailed ?? null,
        pagesSkipped: d.pagesSkipped ?? null,
        newPagesCreated: d.newPagesCreated?.length
          ? JSON.stringify(d.newPagesCreated)
          : null,
      })
      .returning({
        id: autoUpdateRuns.id,
        date: autoUpdateRuns.date,
        startedAt: autoUpdateRuns.startedAt,
        createdAt: autoUpdateRuns.createdAt,
      });

    const run = firstOrThrow(runRow, "auto-update run insert");
    let resultsInserted = 0;

    if (d.results && d.results.length > 0) {
      for (const r of d.results) {
        await tx.insert(autoUpdateResults).values({
          runId: run.id,
          pageId: r.pageId,
          status: r.status,
          tier: r.tier ?? null,
          durationMs: r.durationMs ?? null,
          errorMessage: r.errorMessage ?? null,
        });
        resultsInserted++;
      }
    }

    return { ...run, resultsInserted };
  });

  return c.json(result, 201);
});

// ---- GET /all (paginated list of runs) ----

autoUpdateRunsRoute.get("/all", async (c) => {
  const parsed = PaginationQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { limit, offset } = parsed.data;
  const db = getDrizzleDb();

  const rows = await db
    .select()
    .from(autoUpdateRuns)
    .orderBy(desc(autoUpdateRuns.startedAt))
    .limit(limit)
    .offset(offset);

  const countResult = await db
    .select({ count: count() })
    .from(autoUpdateRuns);
  const total = countResult[0].count;

  // For each run, fetch its results
  const entries = await Promise.all(
    rows.map(async (r) => {
      const results = await db
        .select()
        .from(autoUpdateResults)
        .where(eq(autoUpdateResults.runId, r.id));

      return formatRunEntry(r, results);
    })
  );

  return c.json({ entries, total, limit, offset });
});

// ---- GET /stats (aggregate statistics) ----

autoUpdateRunsRoute.get("/stats", async (c) => {
  const db = getDrizzleDb();

  const totalResult = await db
    .select({ count: count() })
    .from(autoUpdateRuns);
  const totalRuns = totalResult[0].count;

  const budgetResult = await db
    .select({
      total: sql<number>`coalesce(sum(${autoUpdateRuns.budgetSpent}), 0)`,
    })
    .from(autoUpdateRuns);
  const totalBudgetSpent = Number(budgetResult[0].total);

  const updatedResult = await db
    .select({
      total: sql<number>`coalesce(sum(${autoUpdateRuns.pagesUpdated}), 0)`,
    })
    .from(autoUpdateRuns);
  const totalPagesUpdated = Number(updatedResult[0].total);

  const failedResult = await db
    .select({
      total: sql<number>`coalesce(sum(${autoUpdateRuns.pagesFailed}), 0)`,
    })
    .from(autoUpdateRuns);
  const totalPagesFailed = Number(failedResult[0].total);

  const byTrigger = await db
    .select({
      trigger: autoUpdateRuns.trigger,
      count: count(),
    })
    .from(autoUpdateRuns)
    .groupBy(autoUpdateRuns.trigger);

  return c.json({
    totalRuns,
    totalBudgetSpent,
    totalPagesUpdated,
    totalPagesFailed,
    byTrigger: Object.fromEntries(
      byTrigger.map((r) => [r.trigger, r.count])
    ),
  });
});

// ---- GET /:id (single run with results) ----

autoUpdateRunsRoute.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return validationError(c, "id must be a number");

  const db = getDrizzleDb();

  const rows = await db
    .select()
    .from(autoUpdateRuns)
    .where(eq(autoUpdateRuns.id, id));

  if (rows.length === 0) {
    return notFoundError(c, "Run not found");
  }

  const r = rows[0];
  const results = await db
    .select()
    .from(autoUpdateResults)
    .where(eq(autoUpdateResults.runId, r.id));

  return c.json(formatRunEntry(r, results));
});
