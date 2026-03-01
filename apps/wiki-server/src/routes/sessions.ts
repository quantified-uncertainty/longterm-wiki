import { Hono } from "hono";
import { z } from "zod";
import { eq, count, sql, desc, inArray, gte, like } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { sessions, sessionPages } from "../schema.js";
import { parseJsonBody, validationError, invalidJsonError, firstOrThrow, paginationQuery } from "./utils.js";
import {
  CreateSessionSchema as SharedCreateSessionSchema,
  CreateSessionBatchSchema,
  DateStringSchema,
} from "../api-types.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 500;

// ---- Schemas (from shared api-types) ----

const CreateSessionSchema = SharedCreateSessionSchema;
const CreateBatchSchema = CreateSessionBatchSchema;

const PaginationQuery = paginationQuery({ maxLimit: MAX_PAGE_SIZE, defaultLimit: 100 });

const PageChangesQuery = z.object({
  /** Maximum number of sessions to return. Defaults to 500. */
  limit: z.coerce.number().int().min(1).max(2000).default(500),
  /** Only include sessions on or after this date (YYYY-MM-DD). */
  since: DateStringSchema.optional(),
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
    reviewed: r.reviewed,
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
    reviewed: d.reviewed ?? null,
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
  reviewed: sql`excluded.reviewed`,
};

// ---- Routes ----

const sessionsApp = new Hono()
  // ---- POST / (create or update single session) ----
  .post("/", async (c) => {
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
  })
  // ---- POST /batch (create or update multiple sessions) ----
  .post("/batch", async (c) => {
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
  })
  // ---- GET / (list sessions, paginated) ----
  .get("/", async (c) => {
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
  })
  // ---- GET /by-page?page_id=X (sessions that modified a specific page) ----
  .get("/by-page", async (c) => {
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
  })
  // ---- GET /stats ----
  .get("/stats", async (c) => {
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
  })
  // ---- GET /page-changes (optimized endpoint for page-changes dashboard) ----
  .get("/page-changes", async (c) => {
    const parsed = PageChangesQuery.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { limit, since } = parsed.data;
    const db = getDrizzleDb();

    // Step 1: Get the limited set of sessions that have at least one page,
    // with optional date filter pushed into SQL (avoids fetching all rows).
    const whereClause = since ? gte(sessions.date, since) : undefined;

    const sessionIdRows = await db
      .select({ id: sessions.id, date: sessions.date })
      .from(sessions)
      .innerJoin(sessionPages, eq(sessionPages.sessionId, sessions.id))
      .where(whereClause)
      .groupBy(sessions.id, sessions.date)
      .orderBy(desc(sessions.date), desc(sessions.id))
      .limit(limit);

    if (sessionIdRows.length === 0) {
      return c.json({ sessions: [] });
    }

    // Step 2: Fetch full session data and their page associations
    const sessionIds = sessionIdRows.map((r) => r.id);

    const [rows, pageRows] = await Promise.all([
      db
        .select()
        .from(sessions)
        .where(inArray(sessions.id, sessionIds))
        .orderBy(desc(sessions.date), desc(sessions.id)),
      db
        .select()
        .from(sessionPages)
        .where(inArray(sessionPages.sessionId, sessionIds)),
    ]);

    const pageMap = new Map<number, string[]>();
    for (const row of pageRows) {
      const existing = pageMap.get(row.sessionId) || [];
      existing.push(row.pageId);
      pageMap.set(row.sessionId, existing);
    }

    return c.json({
      sessions: rows.map((r) => mapSessionRow(r, pageMap.get(r.id) || [])),
    });
  })
  // ---- GET /insights (learnings + recommendations across sessions) ----
  .get("/insights", async (c) => {
    const branchPrefix = c.req.query("branch_prefix");
    const db = getDrizzleDb();

    // Escape SQL LIKE wildcards in user input
    const whereClause = branchPrefix
      ? like(
          sessions.branch,
          `${branchPrefix.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`
        )
      : undefined;

    const rows = await db
      .select({
        date: sessions.date,
        branch: sessions.branch,
        title: sessions.title,
        learningsJson: sessions.learningsJson,
        recommendationsJson: sessions.recommendationsJson,
      })
      .from(sessions)
      .where(whereClause)
      .orderBy(desc(sessions.date), desc(sessions.id))
      .limit(500);

    type Insight = {
      date: string;
      branch: string | null;
      title: string;
      type: "learning" | "recommendation";
      text: string;
    };
    const insights: Insight[] = [];

    for (const row of rows) {
      const addInsights = (raw: unknown, type: Insight["type"]) => {
        const arr = Array.isArray(raw) ? raw : [];
        for (const item of arr) {
          if (typeof item === "string") {
            insights.push({
              date: row.date,
              branch: row.branch,
              title: row.title,
              type,
              text: item,
            });
          }
        }
      };

      if (row.learningsJson) addInsights(row.learningsJson, "learning");
      if (row.recommendationsJson) addInsights(row.recommendationsJson, "recommendation");
    }

    const byType: Record<string, number> = {};
    for (const insight of insights) {
      byType[insight.type] = (byType[insight.type] || 0) + 1;
    }

    return c.json({
      insights,
      summary: { total: insights.length, byType },
    });
  });

export const sessionsRoute = sessionsApp;
export type SessionsRoute = typeof sessionsApp;
