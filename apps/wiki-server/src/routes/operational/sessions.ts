import { Hono } from "hono";
import { z } from "zod";
import { eq, count, sql, desc, inArray, gte, like } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { logger as rootLogger } from "../../logger.js";
import { sessions, sessionPages, wikiPages } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  firstOrThrow,
  paginationQuery,
  dbError,
  clampedLimit,
} from "../shared/utils.js";
import {
  CreateSessionSchema as SharedCreateSessionSchema,
  CreateSessionBatchSchema,
  DateStringSchema,
} from "../../api-types.js";
import { resolvePageIntId, resolvePageIntIds } from "../shared/page-id-helpers.js";

const logger = rootLogger.child({ component: "sessions" });

// ---- Constants ----

const MAX_PAGE_SIZE = 500;


// ---- Parsers ----

/**
 * Parse a cost string like "~$0.50", "$1.23", "~$10" into integer cents.
 * Returns null if the string cannot be parsed.
 */
export function parseCostCents(cost: string | null | undefined): number | null {
  if (!cost) return null;
  const match = cost.match(/\$\s*([\d.]+)/);
  if (!match) return null;
  const dollars = parseFloat(match[1]);
  if (isNaN(dollars)) return null;
  return Math.round(dollars * 100);
}

/**
 * Parse a duration string like "~20 minutes", "~1.5 hours", "30min", "1h 15m" into minutes (float).
 * Returns null if the string cannot be parsed.
 */
export function parseDurationMinutes(duration: string | null | undefined): number | null {
  if (!duration) return null;
  const lower = duration.toLowerCase();

  // Match "Xh Ym" or "X hours Y minutes" patterns first
  const hoursAndMinutes = lower.match(/([\d.]+)\s*h(?:ours?)?\s+([\d.]+)\s*m(?:in(?:utes?)?)?/);
  if (hoursAndMinutes) {
    const hours = parseFloat(hoursAndMinutes[1]);
    const minutes = parseFloat(hoursAndMinutes[2]);
    if (!isNaN(hours) && !isNaN(minutes)) return hours * 60 + minutes;
  }

  // Match hours: "X hours", "Xh", "X hr"
  const hoursMatch = lower.match(/([\d.]+)\s*h(?:ours?|r)?(?!\s*[\d.])/);
  if (hoursMatch) {
    const hours = parseFloat(hoursMatch[1]);
    if (!isNaN(hours)) return hours * 60;
  }

  // Match minutes: "X minutes", "Xmin", "Xm"
  const minutesMatch = lower.match(/([\d.]+)\s*m(?:in(?:utes?)?)?/);
  if (minutesMatch) {
    const minutes = parseFloat(minutesMatch[1]);
    if (!isNaN(minutes)) return minutes;
  }

  return null;
}

// ---- Schemas (from shared api-types) ----

const CreateSessionSchema = SharedCreateSessionSchema;
const CreateBatchSchema = CreateSessionBatchSchema;

const PaginationQuery = paginationQuery({ maxLimit: MAX_PAGE_SIZE, defaultLimit: 100 });

const PageChangesQuery = z.object({
  /** Maximum number of sessions to return. Defaults to 500. */
  limit: clampedLimit(2000, 500),
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
    costCents: r.costCents,
    durationMinutes: r.durationMinutes,
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
  // Use explicitly provided numeric values if present; otherwise auto-parse from text fields.
  const costCents = d.costCents !== undefined && d.costCents !== null
    ? d.costCents
    : parseCostCents(d.cost ?? null);
  const durationMinutes = d.durationMinutes !== undefined && d.durationMinutes !== null
    ? d.durationMinutes
    : parseDurationMinutes(d.duration ?? null);

  return {
    date: d.date,
    branch: d.branch ?? null,
    title: d.title,
    summary: d.summary ?? null,
    model: d.model ?? null,
    duration: d.duration ?? null,
    cost: d.cost ?? null,
    costCents,
    durationMinutes,
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
  costCents: sql`excluded.cost_cents`,
  durationMinutes: sql`excluded.duration_minutes`,
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

    let result;
    try {
      result = await db.transaction(async (tx) => {
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
          const intIdMap = await resolvePageIntIds(tx, d.pages);
          const droppedSlugs = d.pages.filter((slug) => intIdMap.get(slug) == null);
          if (droppedSlugs.length > 0) {
            logger.warn(
              { droppedSlugs, sessionTitle: d.title },
              `Dropped ${droppedSlugs.length} unresolvable page slug(s) from session`
            );
          }
          const resolved = d.pages
            .map((slug) => ({ sessionId: session.id, pageId: intIdMap.get(slug)! }))
            .filter((v) => v.pageId != null);
          if (resolved.length > 0) {
            await tx.insert(sessionPages).values(resolved);
          }
        }

        return { ...session, pages: d.pages };
      });
    } catch (err) {
      return dbError(c, "session create", err, { title: d.title });
    }

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

    let results;
    try {
      results = await db.transaction(async (tx) => {
        // Pre-collect all page IDs and resolve in one batch query
        const allPageIds = [...new Set(items.flatMap((d) => d.pages))];
        const intIdMap = allPageIds.length > 0
          ? await resolvePageIntIds(tx, allPageIds)
          : new Map<string, number>();

        // Bulk upsert all sessions in one query
        const allVals = items.map((d) => sessionValues(d));
        const upsertedRows = await tx
          .insert(sessions)
          .values(allVals)
          .onConflictDoUpdate({
            target: [sessions.date, sessions.title],
            set: sessionConflictSet,
          })
          .returning({ id: sessions.id, title: sessions.title });

        const sessionIds = upsertedRows.map((r) => r.id);

        // Bulk delete old page associations for all affected sessions
        if (sessionIds.length > 0) {
          await tx
            .delete(sessionPages)
            .where(inArray(sessionPages.sessionId, sessionIds));
        }

        // Bulk insert all new page associations
        const allPageAssociations: Array<{
          sessionId: number;
          pageId: number;
        }> = [];
        const batchDroppedSlugs: string[] = [];
        for (let i = 0; i < items.length; i++) {
          const d = items[i];
          const sessionId = upsertedRows[i].id;
          for (const slug of d.pages) {
            const intId = intIdMap.get(slug);
            if (intId != null) {
              allPageAssociations.push({ sessionId, pageId: intId });
            } else {
              batchDroppedSlugs.push(slug);
            }
          }
        }
        if (batchDroppedSlugs.length > 0) {
          logger.warn(
            { droppedSlugs: batchDroppedSlugs, itemCount: items.length },
            `Dropped ${batchDroppedSlugs.length} unresolvable page slug(s) from session batch`
          );
        }
        if (allPageAssociations.length > 0) {
          await tx
            .insert(sessionPages)
            .values(allPageAssociations);
        }

        return upsertedRows.map((row, i) => ({
          id: row.id,
          title: row.title,
          pageCount: items[i].pages.length,
        }));
      });
    } catch (err) {
      return dbError(c, "session batch", err, { itemCount: items.length });
    }

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
        .select({
          sessionId: sessionPages.sessionId,
          pageSlug: wikiPages.slug,
        })
        .from(sessionPages)
        .leftJoin(wikiPages, eq(wikiPages.id, sessionPages.pageId))
        .where(inArray(sessionPages.sessionId, sessionIds));

      for (const row of pageRows) {
        if (!row.pageSlug) continue;
        const existing = pageMap.get(row.sessionId) || [];
        existing.push(row.pageSlug);
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

    // Resolve slug to integer ID
    const intId = await resolvePageIntId(db, pageId);
    if (intId === null) return c.json({ sessions: [] });

    // Find session IDs that include this page
    const spRows = await db
      .select({ sessionId: sessionPages.sessionId })
      .from(sessionPages)
      .where(eq(sessionPages.pageId, intId));

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
      .select({ sessionId: sessionPages.sessionId, pageSlug: wikiPages.slug })
      .from(sessionPages)
      .leftJoin(wikiPages, eq(wikiPages.id, sessionPages.pageId))
      .where(inArray(sessionPages.sessionId, sessionIds));

    const pageMap = new Map<number, string[]>();
    for (const row of allPageRows) {
      if (!row.pageSlug) continue;
      const existing = pageMap.get(row.sessionId) || [];
      existing.push(row.pageSlug);
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
        .select({ sessionId: sessionPages.sessionId, pageSlug: wikiPages.slug })
        .from(sessionPages)
        .leftJoin(wikiPages, eq(wikiPages.id, sessionPages.pageId))
        .where(inArray(sessionPages.sessionId, sessionIds)),
    ]);

    const pageMap = new Map<number, string[]>();
    for (const row of pageRows) {
      if (!row.pageSlug) continue;
      const existing = pageMap.get(row.sessionId) || [];
      existing.push(row.pageSlug);
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
          `${branchPrefix.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`
        )
      : undefined;

    // Use a high limit and warn on truncation; insights are internal-only and grow slowly.
    // If the session count ever approaches this limit, switch to pagination.
    const INSIGHTS_LIMIT = 5000;
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
      .limit(INSIGHTS_LIMIT);

    if (rows.length === INSIGHTS_LIMIT) {
      logger.warn(
        { limit: INSIGHTS_LIMIT },
        "sessions/insights result count hit limit; insights may be truncated — consider adding pagination"
      );
    }

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
