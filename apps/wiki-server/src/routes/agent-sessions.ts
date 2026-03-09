import { Hono } from "hono";
import { eq, desc, and, lt, count, sql, inArray, gte, like } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { logger } from "../logger.js";
import { agentSessions, agentSessionPages } from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  firstOrThrow,
} from "./utils.js";
import {
  CreateAgentSessionSchema,
  UpdateAgentSessionSchema,
  DateStringSchema,
} from "../api-types.js";
import { z } from "zod";
import { resolvePageIntIds } from "./page-id-helpers.js";

// ---- Parsers ----

/**
 * Parse a cost string like "~$0.50", "$1.23", "~$10" into integer cents.
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
 * Parse a duration string like "~20 minutes", "~1.5 hours", "30min", "1h 15m" into minutes.
 */
export function parseDurationMinutes(duration: string | null | undefined): number | null {
  if (!duration) return null;
  const lower = duration.toLowerCase();
  const hoursAndMinutes = lower.match(/([\d.]+)\s*h(?:ours?)?\s+([\d.]+)\s*m(?:in(?:utes?)?)?/);
  if (hoursAndMinutes) {
    const h = parseFloat(hoursAndMinutes[1]);
    const m = parseFloat(hoursAndMinutes[2]);
    if (!isNaN(h) && !isNaN(m)) return h * 60 + m;
  }
  const hoursMatch = lower.match(/([\d.]+)\s*h(?:ours?|r)?(?!\s*[\d.])/);
  if (hoursMatch) {
    const h = parseFloat(hoursMatch[1]);
    if (!isNaN(h)) return h * 60;
  }
  const minutesMatch = lower.match(/([\d.]+)\s*m(?:in(?:utes?)?)?/);
  if (minutesMatch) {
    const m = parseFloat(minutesMatch[1]);
    if (!isNaN(m)) return m;
  }
  return null;
}

// ---- Query schemas ----

const PageChangesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(2000).default(500),
  since: DateStringSchema.optional(),
});

const InsightsQuery = z.object({
  branch_prefix: z.string().max(200).optional(),
});

// ---- Helpers ----

function mapSessionRow(r: typeof agentSessions.$inferSelect, pages: string[]) {
  return {
    id: r.id,
    branch: r.branch,
    task: r.task,
    sessionType: r.sessionType,
    issueNumber: r.issueNumber,
    worktree: r.worktree,
    prUrl: r.prUrl,
    prOutcome: r.prOutcome,
    fixesPrUrl: r.fixesPrUrl,
    status: r.status,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    date: r.date,
    title: r.title,
    summary: r.summary,
    model: r.model,
    duration: r.duration,
    durationMinutes: r.durationMinutes,
    cost: r.cost,
    costCents: r.costCents,
    checksYaml: r.checksYaml,
    issuesJson: r.issuesJson,
    learningsJson: r.learningsJson,
    recommendationsJson: r.recommendationsJson,
    reviewed: r.reviewed,
    pages,
  };
}

const agentSessionsApp = new Hono()
  .post("/", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);
    const parsed = CreateAgentSessionSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);
    const d = parsed.data;
    const db = getDrizzleDb();
    const { row, isUpdate } = await db.transaction(async (tx) => {
      const existing = await tx.select().from(agentSessions)
        .where(eq(agentSessions.branch, d.branch))
        .orderBy(desc(agentSessions.startedAt)).limit(1);
      if (existing.length > 0 && existing[0].status === "active") {
        const updated = await tx.update(agentSessions).set({
          task: d.task, sessionType: d.sessionType,
          issueNumber: d.issueNumber ?? null, checklistMd: d.checklistMd,
          worktree: d.worktree ?? existing[0].worktree ?? null, updatedAt: new Date(),
        }).where(eq(agentSessions.id, existing[0].id)).returning();
        return { row: firstOrThrow(updated, "agent session update"), isUpdate: true };
      }
      const inserted = await tx.insert(agentSessions).values({
        branch: d.branch, task: d.task, sessionType: d.sessionType,
        issueNumber: d.issueNumber ?? null, checklistMd: d.checklistMd, worktree: d.worktree ?? null,
      }).returning();
      return { row: firstOrThrow(inserted, "agent session insert"), isUpdate: false };
    });
    return c.json(row, isUpdate ? 200 : 201);
  })
  .get("/by-branch/:branch", async (c) => {
    const branch = c.req.param("branch");
    const db = getDrizzleDb();
    const rows = await db.select().from(agentSessions)
      .where(eq(agentSessions.branch, branch))
      .orderBy(desc(agentSessions.startedAt)).limit(1);
    if (rows.length === 0) {
      return c.json({ error: "not_found", message: `No session for branch: ${branch}` }, 404);
    }
    return c.json(rows[0]);
  })
  .get("/stats", async (c) => {
    const db = getDrizzleDb();
    const [row] = await db.select({
      total: count(),
      fixSessions: count(sql`CASE WHEN ${agentSessions.fixesPrUrl} IS NOT NULL THEN 1 END`),
    }).from(agentSessions);
    const total = row?.total ?? 0;
    const fixSessions = row?.fixSessions ?? 0;
    const fixRate = total > 0 ? fixSessions / total : 0;
    const pagesResult = await db
      .select({ count: sql<number>`count(distinct ${agentSessionPages.pageId})` })
      .from(agentSessionPages);
    const uniquePages = Number(pagesResult[0]?.count ?? 0);
    const totalPageEditsResult = await db.select({ count: count() }).from(agentSessionPages);
    const totalPageEdits = totalPageEditsResult[0]?.count ?? 0;
    return c.json({ total, fixSessions, fixRate, uniquePages, totalPageEdits });
  })
  .patch("/:id", async (c) => {
    const raw = c.req.param("id");
    const id = Number(raw);
    if (!Number.isInteger(id) || id < 1) return validationError(c, "Invalid session ID");
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);
    const parsed = UpdateAgentSessionSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);
    const {
      checklistMd, status, prUrl, prOutcome, fixesPrUrl,
      date, title, summary, model, duration, cost, durationMinutes, checksYaml,
      issuesJson, learningsJson, recommendationsJson, reviewed, pages,
    } = parsed.data;
    const resolvedCostCents = parsed.data.costCents !== undefined
      ? parsed.data.costCents
      : cost !== undefined ? parseCostCents(cost) : undefined;
    const resolvedDurationMinutes = durationMinutes !== undefined
      ? durationMinutes
      : duration !== undefined ? parseDurationMinutes(duration) : undefined;
    const hasAnyField = [
      checklistMd, status, prUrl, prOutcome, fixesPrUrl,
      date, title, summary, model, duration, cost, checksYaml,
      issuesJson, learningsJson, recommendationsJson, reviewed, pages,
    ].some((v) => v !== undefined);
    if (!hasAnyField) return validationError(c, "At least one field must be provided");
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (checklistMd !== undefined) updates.checklistMd = checklistMd;
    if (status !== undefined) { updates.status = status; if (status === "completed") updates.completedAt = new Date(); }
    if (prUrl !== undefined) updates.prUrl = prUrl;
    if (prOutcome !== undefined) updates.prOutcome = prOutcome;
    if (fixesPrUrl !== undefined) updates.fixesPrUrl = fixesPrUrl;
    if (date !== undefined) updates.date = date;
    if (title !== undefined) updates.title = title;
    if (summary !== undefined) updates.summary = summary;
    if (model !== undefined) updates.model = model;
    if (duration !== undefined) updates.duration = duration;
    if (resolvedDurationMinutes !== undefined) updates.durationMinutes = resolvedDurationMinutes;
    if (cost !== undefined) updates.cost = cost;
    if (resolvedCostCents !== undefined) updates.costCents = resolvedCostCents;
    if (checksYaml !== undefined) updates.checksYaml = checksYaml;
    if (issuesJson !== undefined) updates.issuesJson = issuesJson;
    if (learningsJson !== undefined) updates.learningsJson = learningsJson;
    if (recommendationsJson !== undefined) updates.recommendationsJson = recommendationsJson;
    if (reviewed !== undefined) updates.reviewed = reviewed;
    const db = getDrizzleDb();
    const result = await db.transaction(async (tx) => {
      const rows = await tx.update(agentSessions).set(updates)
        .where(eq(agentSessions.id, id)).returning();
      if (rows.length === 0) return null;
      if (pages !== undefined) {
        await tx.delete(agentSessionPages).where(eq(agentSessionPages.agentSessionId, id));
        if (pages.length > 0) {
          const uniquePages = [...new Set(pages)];
          const intIdMap = await resolvePageIntIds(tx, uniquePages);
          await tx.insert(agentSessionPages).values(
            uniquePages.map((pageId) => ({
              agentSessionId: id, pageId, pageIdInt: intIdMap.get(pageId) ?? null,
            }))
          );
        }
      }
      return rows[0];
    });
    if (!result) return c.json({ error: "not_found", message: `No session with id: ${id}` }, 404);
    return c.json(result);
  })
  .get("/", async (c) => {
    const limit = Math.min(Number(c.req.query("limit") || 50), 200);
    const db = getDrizzleDb();
    const rows = await db.select().from(agentSessions)
      .orderBy(desc(agentSessions.startedAt)).limit(limit);
    return c.json({ sessions: rows });
  })
  .get("/page-changes", async (c) => {
    const parsed = PageChangesQuery.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.message);
    const { limit, since } = parsed.data;
    const db = getDrizzleDb();
    const whereClause = since ? gte(agentSessions.date, since) : undefined;
    const sessionIdRows = await db
      .select({ id: agentSessions.id, date: agentSessions.date })
      .from(agentSessions)
      .innerJoin(agentSessionPages, eq(agentSessionPages.agentSessionId, agentSessions.id))
      .where(whereClause)
      .groupBy(agentSessions.id, agentSessions.date)
      .orderBy(desc(agentSessions.date), desc(agentSessions.id))
      .limit(limit);
    if (sessionIdRows.length === 0) return c.json({ sessions: [] });
    const sessionIds = sessionIdRows.map((r) => r.id);
    const [rows, pageRows] = await Promise.all([
      db.select().from(agentSessions).where(inArray(agentSessions.id, sessionIds))
        .orderBy(desc(agentSessions.date), desc(agentSessions.id)),
      db.select().from(agentSessionPages).where(inArray(agentSessionPages.agentSessionId, sessionIds)),
    ]);
    const pageMap = new Map<number, string[]>();
    for (const row of pageRows) {
      const existing = pageMap.get(row.agentSessionId) || [];
      existing.push(row.pageId);
      pageMap.set(row.agentSessionId, existing);
    }
    return c.json({ sessions: rows.map((r) => mapSessionRow(r, pageMap.get(r.id) || [])) });
  })
  .get("/by-page", async (c) => {
    const pageId = c.req.query("page_id");
    if (!pageId) return validationError(c, "page_id query parameter is required");
    const db = getDrizzleDb();
    const aspRows = await db.select({ agentSessionId: agentSessionPages.agentSessionId })
      .from(agentSessionPages).where(eq(agentSessionPages.pageId, pageId));
    if (aspRows.length === 0) return c.json({ sessions: [] });
    const sessionIds = aspRows.map((r) => r.agentSessionId);
    const rows = await db.select().from(agentSessions)
      .where(inArray(agentSessions.id, sessionIds))
      .orderBy(desc(agentSessions.date), desc(agentSessions.id));
    const allPageRows = await db.select().from(agentSessionPages)
      .where(inArray(agentSessionPages.agentSessionId, sessionIds));
    const pageMap = new Map<number, string[]>();
    for (const row of allPageRows) {
      const existing = pageMap.get(row.agentSessionId) || [];
      existing.push(row.pageId);
      pageMap.set(row.agentSessionId, existing);
    }
    return c.json({ sessions: rows.map((r) => mapSessionRow(r, pageMap.get(r.id) || [])) });
  })
  .get("/insights", async (c) => {
    const parsed = InsightsQuery.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.message);
    const { branch_prefix: branchPrefix } = parsed.data;
    const db = getDrizzleDb();
    const whereClause = branchPrefix
      ? like(agentSessions.branch, `${branchPrefix.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`)
      : undefined;
    const INSIGHTS_LIMIT = 5000;
    const rows = await db.select({
      date: agentSessions.date, branch: agentSessions.branch,
      title: agentSessions.title, task: agentSessions.task,
      learningsJson: agentSessions.learningsJson,
      recommendationsJson: agentSessions.recommendationsJson,
    }).from(agentSessions).where(whereClause)
      .orderBy(desc(agentSessions.date), desc(agentSessions.id)).limit(INSIGHTS_LIMIT);
    type Insight = { date: string | null; branch: string | null; title: string | null; type: "learning" | "recommendation"; text: string; };
    const insights: Insight[] = [];
    for (const row of rows) {
      const addInsights = (raw: unknown, type: Insight["type"]) => {
        const arr = Array.isArray(raw) ? raw : [];
        for (const item of arr) {
          if (typeof item === "string") {
            insights.push({ date: row.date, branch: row.branch, title: row.title ?? row.task, type, text: item });
          }
        }
      };
      if (row.learningsJson) addInsights(row.learningsJson, "learning");
      if (row.recommendationsJson) addInsights(row.recommendationsJson, "recommendation");
    }
    const byType: Record<string, number> = {};
    for (const insight of insights) byType[insight.type] = (byType[insight.type] || 0) + 1;
    return c.json({ insights, summary: { total: insights.length, byType } });
  })
  .post("/sweep", async (c) => {
    const body = await parseJsonBody(c).catch(() => ({}));
    const raw = Number((body as Record<string, unknown>)?.timeoutHours || 2);
    const timeoutHours = Math.max(1, Math.min(Number.isFinite(raw) ? raw : 2, 720));
    const cutoff = new Date(Date.now() - timeoutHours * 60 * 60 * 1000);
    const db = getDrizzleDb();
    const stale = await db.update(agentSessions)
      .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(agentSessions.status, "active"), lt(agentSessions.updatedAt, cutoff)))
      .returning({ id: agentSessions.id, branch: agentSessions.branch, issueNumber: agentSessions.issueNumber });
    logger.info({ swept: stale.length, cutoff: cutoff.toISOString() }, "Sweep: marked stale sessions as completed");
    return c.json({ swept: stale.length, sessions: stale });
  });

export const agentSessionsRoute = agentSessionsApp;
export type AgentSessionsRoute = typeof agentSessionsApp;
