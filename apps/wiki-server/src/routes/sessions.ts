import { Hono } from "hono";
import { z } from "zod";
import { eq, count, sql, desc, inArray } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { sessions, sessionPages } from "../schema.js";
import { parseJsonBody, validationError, invalidJsonError, firstOrThrow } from "./utils.js";
import { CreateSessionSchema as SharedCreateSessionSchema, CreateSessionBatchSchema } from "../api-types.js";

export const sessionsRoute = new Hono();

// ---- Constants ----

const MAX_PAGE_SIZE = 500;

// ---- Schemas (from shared api-types) ----

const CreateSessionSchema = SharedCreateSessionSchema;
const CreateBatchSchema = CreateSessionBatchSchema;

const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Helpers ----

function mapSessionRow(
  r: typeof sessions.$inferSelect,
  pages: string[]
) {
  return {
    id: r.id,
    date: r.date,
    branch: r.branch,
    title: r.title,
    summary: r.summary,
    model: r.model,
    duration: r.duration,
    cost: r.cost,
    prUrl: r.prUrl,
    checksYaml: r.checksYaml,
    issuesJson: r.issuesJson,
    learningsJson: r.learningsJson,
    recommendationsJson: r.recommendationsJson,
    pages,
    createdAt: r.createdAt,
  };
}

function sessionValues(d: z.infer<typeof CreateSessionSchema>) {
  return {
    date: d.date,
    branch: d.branch ?? null,
    title: d.title,
    summary: d.summary ?? null,
    model: d.model ?? null,
    duration: d.duration ?? null,
    cost: d.cost ?? null,
    prUrl: d.prUrl ?? null,
    checksYaml: d.checksYaml ?? null,
    issuesJson: d.issuesJson ?? null,
    learningsJson: d.learningsJson ?? null,
    recommendationsJson: d.recommendationsJson ?? null,
  };
}

/** Fields to update on conflict (everything except date/title which form the unique key) */
const sessionConflictSet = {
  branch: sql`excluded.branch`,
  summary: sql`excluded.summary`,
  model: sql`excluded.model`,
  duration: sql`excluded.duration`,
  cost: sql`excluded.cost`,
  prUrl: sql`excluded.pr_url`,
  checksYaml: sql`excluded.checks_yaml`,
  issuesJson: sql`excluded.issues_json`,
  learningsJson: sql`excluded.learnings_json`,
  recommendationsJson: sql`excluded.recommendations_json`,
};

// ---- POST / (create or update single session) ----

sessionsRoute.post("/", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = CreateSessionSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const d = parsed.data;
  const db = getDrizzleDb();

  const result = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(sessions)
      .values(sessionValues(d))
      .onConflictDoUpdate({
        target: [sessions.date, sessions.title],
        set: sessionConflictSet,
      })
      .returning({
        id: sessions.id,
        date: sessions.date,
        title: sessions.title,
        createdAt: sessions.createdAt,
      });

    const session = firstOrThrow(rows, "session upsert");

    // Replace page associations: delete old, insert new
    await tx
      .delete(sessionPages)
      .where(eq(sessionPages.sessionId, session.id));

    if (d.pages.length > 0) {
      await tx
        .insert(sessionPages)
        .values(d.pages.map((pageId) => ({ sessionId: session.id, pageId })));
    }

    return { ...session, pages: d.pages };
  });

  return c.json(result, 201);
});

// ---- POST /batch (create or update multiple sessions) ----

sessionsRoute.post("/batch", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = CreateBatchSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { items } = parsed.data;
  const db = getDrizzleDb();

  const results = await db.transaction(async (tx) => {
    const created: Array<{ id: number; title: string; pageCount: number }> = [];

    for (const d of items) {
      const rows = await tx
        .insert(sessions)
        .values(sessionValues(d))
        .onConflictDoUpdate({
          target: [sessions.date, sessions.title],
          set: sessionConflictSet,
        })
        .returning({ id: sessions.id, title: sessions.title });

      const session = firstOrThrow(rows, `session batch upsert "${d.title}"`);

      // Replace page associations: delete old, insert new
      await tx
        .delete(sessionPages)
        .where(eq(sessionPages.sessionId, session.id));

      if (d.pages.length > 0) {
        await tx
          .insert(sessionPages)
          .values(d.pages.map((pageId) => ({ sessionId: session.id, pageId })));
      }

      created.push({
        id: session.id,
        title: session.title,
        pageCount: d.pages.length,
      });
    }

    return created;
  });

  return c.json({ upserted: results.length, results }, 201);
});

// ---- GET / (list sessions, paginated) ----

sessionsRoute.get("/", async (c) => {
  const parsed = PaginationQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { limit, offset } = parsed.data;
  const db = getDrizzleDb();

  const rows = await db
    .select()
    .from(sessions)
    .orderBy(desc(sessions.date), desc(sessions.id))
    .limit(limit)
    .offset(offset);

  const countResult = await db.select({ count: count() }).from(sessions);
  const total = countResult[0].count;

  // Fetch page associations for each session
  const sessionIds = rows.map((r) => r.id);
  let pageMap = new Map<number, string[]>();

  if (sessionIds.length > 0) {
    const pageRows = await db
      .select()
      .from(sessionPages)
      .where(inArray(sessionPages.sessionId, sessionIds));

    for (const row of pageRows) {
      const existing = pageMap.get(row.sessionId) || [];
      existing.push(row.pageId);
      pageMap.set(row.sessionId, existing);
    }
  }

  return c.json({
    sessions: rows.map((r) => mapSessionRow(r, pageMap.get(r.id) || [])),
    total,
    limit,
    offset,
  });
});

// ---- GET /by-page?page_id=X (sessions that modified a specific page) ----

sessionsRoute.get("/by-page", async (c) => {
  const pageId = c.req.query("page_id");
  if (!pageId) return validationError(c, "page_id query parameter is required");

  const db = getDrizzleDb();

  // Find session IDs that include this page
  const spRows = await db
    .select({ sessionId: sessionPages.sessionId })
    .from(sessionPages)
    .where(eq(sessionPages.pageId, pageId));

  if (spRows.length === 0) {
    return c.json({ sessions: [] });
  }

  const sessionIds = spRows.map((r) => r.sessionId);

  const rows = await db
    .select()
    .from(sessions)
    .where(inArray(sessions.id, sessionIds))
    .orderBy(desc(sessions.date), desc(sessions.id));

  // Also fetch all pages for these sessions
  const allPageRows = await db
    .select()
    .from(sessionPages)
    .where(inArray(sessionPages.sessionId, sessionIds));

  const pageMap = new Map<number, string[]>();
  for (const row of allPageRows) {
    const existing = pageMap.get(row.sessionId) || [];
    existing.push(row.pageId);
    pageMap.set(row.sessionId, existing);
  }

  return c.json({
    sessions: rows.map((r) => mapSessionRow(r, pageMap.get(r.id) || [])),
  });
});

// ---- GET /stats ----

sessionsRoute.get("/stats", async (c) => {
  const db = getDrizzleDb();

  const totalResult = await db.select({ count: count() }).from(sessions);
  const totalSessions = totalResult[0].count;

  const pagesResult = await db
    .select({
      count: sql<number>`count(distinct ${sessionPages.pageId})`,
    })
    .from(sessionPages);
  const uniquePages = Number(pagesResult[0].count);

  const totalPageEditsResult = await db
    .select({ count: count() })
    .from(sessionPages);
  const totalPageEdits = totalPageEditsResult[0].count;

  const byModel = await db
    .select({
      model: sessions.model,
      count: count(),
    })
    .from(sessions)
    .groupBy(sessions.model)
    .orderBy(desc(count()));

  return c.json({
    totalSessions,
    uniquePages,
    totalPageEdits,
    byModel: Object.fromEntries(
      byModel
        .filter((r) => r.model !== null)
        .map((r) => [r.model, r.count])
    ),
  });
});

// ---- GET /page-changes (optimized endpoint for page-changes dashboard) ----

sessionsRoute.get("/page-changes", async (c) => {
  const db = getDrizzleDb();

  // Get all sessions that have at least one page
  const sessionsWithPages = await db
    .select({
      sessionId: sessionPages.sessionId,
      pageId: sessionPages.pageId,
    })
    .from(sessionPages);

  if (sessionsWithPages.length === 0) {
    return c.json({ sessions: [] });
  }

  // Group page IDs by session
  const pageMap = new Map<number, string[]>();
  const allSessionIds = new Set<number>();
  for (const row of sessionsWithPages) {
    allSessionIds.add(row.sessionId);
    const existing = pageMap.get(row.sessionId) || [];
    existing.push(row.pageId);
    pageMap.set(row.sessionId, existing);
  }

  const sessionIdArray = Array.from(allSessionIds);
  const rows = await db
    .select()
    .from(sessions)
    .where(inArray(sessions.id, sessionIdArray))
    .orderBy(desc(sessions.date), desc(sessions.id));

  return c.json({
    sessions: rows.map((r) => mapSessionRow(r, pageMap.get(r.id) || [])),
  });
});
