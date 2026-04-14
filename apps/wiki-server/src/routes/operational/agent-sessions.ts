import { Hono } from "hono";
import { eq, desc, and, lt, count, sql, inArray, gte, like } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { logger } from "../../logger.js";
import { agentSessions, agentSessionPages, agentSessionEntities, wikiPages } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  firstOrThrow,
  escapeIlike,
  clampedLimit,
  zv,
} from "../shared/utils.js";
import {
  CreateAgentSessionSchema,
  UpdateAgentSessionSchema,
  DateStringSchema,
  LINEAR_ID_PATTERN,
} from "../../api-types.js";
import { z } from "zod";
import { resolvePageIntId, resolvePageIntIds } from "../shared/page-id-helpers.js";
import { parseCostCents, parseDurationMinutes } from "./sessions.js";

// ---- Query schemas ----

const PageChangesQuery = z.object({
  limit: clampedLimit(2000, 500),
  since: DateStringSchema.optional(),
});

const ListSessionsQuery = z.object({
  limit: clampedLimit(200, 50),
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
    linearId: r.linearId,
    slotNumber: r.slotNumber,
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
        // Merge rules:
        //   undefined (field omitted) → preserve existing
        //   null (explicit clear)     → overwrite with null
        //   value                     → overwrite with value
        // Using `?? existing ?? null` would silently treat `null` as
        // "preserve" which is wrong — callers must be able to clear fields.
        const updated = await tx.update(agentSessions).set({
          task: d.task, sessionType: d.sessionType,
          issueNumber: d.issueNumber !== undefined ? d.issueNumber : (existing[0].issueNumber ?? null),
          linearId: d.linearId !== undefined ? d.linearId : (existing[0].linearId ?? null),
          slotNumber: d.slotNumber !== undefined ? d.slotNumber : (existing[0].slotNumber ?? null),
          checklistMd: d.checklistMd,
          worktree: d.worktree !== undefined ? d.worktree : (existing[0].worktree ?? null),
          updatedAt: new Date(),
        }).where(eq(agentSessions.id, existing[0].id)).returning();
        return { row: firstOrThrow(updated, "agent session update"), isUpdate: true };
      }
      const inserted = await tx.insert(agentSessions).values({
        branch: d.branch, task: d.task, sessionType: d.sessionType,
        issueNumber: d.issueNumber ?? null,
        linearId: d.linearId ?? null,
        slotNumber: d.slotNumber ?? null,
        checklistMd: d.checklistMd, worktree: d.worktree ?? null,
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
  // QUA-440: "who is actively working on QUA-NNN right now?"
  // Returns sessions whose linear_id matches, filtered to active status and
  // recent updated_at (heartbeat proxy). Used by `crux linear start`'s
  // DB-first dedup pre-check in `crux/lib/linear/dedup.ts`.
  .get(
    "/by-linear/:linearId",
    zv(
      "query",
      z.object({
        // How fresh updated_at must be to count as an active claim. Defaults
        // to 30 min (matches the existing active_agents stale timeout).
        // Capped at 24h so a bad query can't return ancient rows.
        freshMinutes: z.coerce.number().int().min(1).max(1440).default(30),
      }),
    ),
    async (c) => {
      const linearId = c.req.param("linearId");
      // Length cap before regex to bound the regex-match cost and match the
      // `.max(50)` bound on LinearIdSchema in api-types.ts. The regex itself
      // is anchored and linear-time but explicit bounds are defense in
      // depth against a future non-anchored refactor.
      if (linearId.length > 50 || !LINEAR_ID_PATTERN.test(linearId)) {
        return validationError(c, "Invalid Linear ID format (expected ^[A-Z]+-\\d+$, max 50 chars)");
      }
      const { freshMinutes } = c.req.valid("query");
      const cutoff = new Date(Date.now() - freshMinutes * 60_000);
      const db = getDrizzleDb();
      const rows = await db.select().from(agentSessions)
        .where(and(
          eq(agentSessions.linearId, linearId),
          eq(agentSessions.status, "active"),
          gte(agentSessions.updatedAt, cutoff),
        ))
        .orderBy(desc(agentSessions.updatedAt));
      return c.json({
        sessions: rows.map((r) => mapSessionRow(r, [])),
        freshMinutes,
      });
    },
  )
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
      issuesJson, learningsJson, recommendationsJson, reviewed, pages, entities,
      linearId, slotNumber,
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
      issuesJson, learningsJson, recommendationsJson, reviewed, pages, entities,
      parsed.data.costCents, parsed.data.durationMinutes,
      linearId, slotNumber,
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
    if (linearId !== undefined) updates.linearId = linearId;
    if (slotNumber !== undefined) updates.slotNumber = slotNumber;
    const db = getDrizzleDb();
    // Sentinel error used to roll back the transaction when status='completed'
    // is attempted with missing required fields. Thrown inside the transaction
    // so the UPDATE is rolled back rather than committed then rejected.
    class IncompleteSessionError extends Error {
      constructor(public readonly missing: string[]) {
        super("incomplete_session");
      }
    }
    let result;
    try {
      result = await db.transaction(async (tx) => {
        const rows = await tx.update(agentSessions).set(updates)
          .where(eq(agentSessions.id, id)).returning();
        if (rows.length === 0) return null;
        const row = rows[0];

        // Hard-fail validation: when status is being SET to 'completed', required
        // fields must be present on the resulting row. Runs INSIDE the transaction
        // so a violation rolls back the UPDATE (otherwise the DB would end up with
        // status='completed' despite the 400 response).
        if (status === "completed") {
          const missing: string[] = [];
          if (!row.title) missing.push("title");
          if (!row.summary) missing.push("summary");
          if (missing.length > 0) {
            throw new IncompleteSessionError(missing);
          }
        }

        if (pages !== undefined) {
          await tx.delete(agentSessionPages).where(eq(agentSessionPages.agentSessionId, id));
          if (pages.length > 0) {
            const uniquePages = [...new Set(pages)];
            const intIdMap = await resolvePageIntIds(tx, uniquePages);
            const resolved = uniquePages
              .map((slug) => ({ agentSessionId: id, pageId: intIdMap.get(slug)! }))
              .filter((v) => v.pageId != null);
            if (resolved.length > 0) {
              await tx.insert(agentSessionPages).values(resolved);
            }
          }
        }
        if (entities !== undefined) {
          await tx.delete(agentSessionEntities).where(eq(agentSessionEntities.agentSessionId, id));
          if (entities.length > 0) {
            const uniqueEntities = [...new Set(entities)];
            await tx.insert(agentSessionEntities).values(
              uniqueEntities.map((stableId) => ({ agentSessionId: id, entityStableId: stableId })),
            );
          }
        }
        return row;
      });
    } catch (err) {
      if (err instanceof IncompleteSessionError) {
        logger.warn({ sessionId: id, missing: err.missing }, "Session marked completed with missing required fields — rolled back");
        return c.json({
          error: "incomplete_session",
          message: `Sessions with status='completed' require: ${err.missing.join(", ")}. ` +
            `Run 'crux sys session-finalize' to populate these fields from the transcript.`,
          missing: err.missing,
        }, 400);
      }
      throw err;
    }
    if (!result) return c.json({ error: "not_found", message: `No session with id: ${id}` }, 404);

    return c.json(result);
  })
  .get("/", zv("query", ListSessionsQuery), async (c) => {
    const { limit } = c.req.valid("query");
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
      db.select({ agentSessionId: agentSessionPages.agentSessionId, pageSlug: wikiPages.slug })
        .from(agentSessionPages)
        .leftJoin(wikiPages, eq(wikiPages.id, agentSessionPages.pageId))
        .where(inArray(agentSessionPages.agentSessionId, sessionIds)),
    ]);
    const pageMap = new Map<number, string[]>();
    for (const row of pageRows) {
      if (!row.pageSlug) continue;
      const existing = pageMap.get(row.agentSessionId) || [];
      existing.push(row.pageSlug);
      pageMap.set(row.agentSessionId, existing);
    }
    return c.json({ sessions: rows.map((r) => mapSessionRow(r, pageMap.get(r.id) || [])) });
  })
  .get("/by-page", async (c) => {
    const pageId = c.req.query("page_id");
    if (!pageId) return validationError(c, "page_id query parameter is required");
    const db = getDrizzleDb();
    // Resolve slug to integer ID for lookup
    const intId = await resolvePageIntId(db, pageId);
    if (intId === null) return c.json({ sessions: [] });
    const aspRows = await db.select({ agentSessionId: agentSessionPages.agentSessionId })
      .from(agentSessionPages).where(eq(agentSessionPages.pageId, intId));
    if (aspRows.length === 0) return c.json({ sessions: [] });
    const sessionIds = aspRows.map((r) => r.agentSessionId);
    const rows = await db.select().from(agentSessions)
      .where(inArray(agentSessions.id, sessionIds))
      .orderBy(desc(agentSessions.date), desc(agentSessions.id));
    const allPageRows = await db.select({ agentSessionId: agentSessionPages.agentSessionId, pageSlug: wikiPages.slug })
      .from(agentSessionPages)
      .leftJoin(wikiPages, eq(wikiPages.id, agentSessionPages.pageId))
      .where(inArray(agentSessionPages.agentSessionId, sessionIds));
    const pageMap = new Map<number, string[]>();
    for (const row of allPageRows) {
      if (!row.pageSlug) continue;
      const existing = pageMap.get(row.agentSessionId) || [];
      existing.push(row.pageSlug);
      pageMap.set(row.agentSessionId, existing);
    }
    return c.json({ sessions: rows.map((r) => mapSessionRow(r, pageMap.get(r.id) || [])) });
  })
  .get("/by-entity", async (c) => {
    const entityId = c.req.query("entity_id");
    if (!entityId) return validationError(c, "entity_id query parameter is required");
    const db = getDrizzleDb();
    const rows = await db
      .select({
        id: agentSessions.id,
        branch: agentSessions.branch,
        task: agentSessions.task,
        sessionType: agentSessions.sessionType,
        date: agentSessions.date,
        title: agentSessions.title,
        summary: agentSessions.summary,
        prUrl: agentSessions.prUrl,
        status: agentSessions.status,
      })
      .from(agentSessions)
      .innerJoin(agentSessionEntities, eq(agentSessionEntities.agentSessionId, agentSessions.id))
      .where(eq(agentSessionEntities.entityStableId, entityId))
      .orderBy(desc(agentSessions.date), desc(agentSessions.id))
      .limit(20);
    return c.json({ sessions: rows });
  })
  .get("/insights", async (c) => {
    const parsed = InsightsQuery.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.message);
    const { branch_prefix: branchPrefix } = parsed.data;
    const db = getDrizzleDb();
    const whereClause = branchPrefix
      ? like(agentSessions.branch, `${escapeIlike(branchPrefix)}%`)
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
    // Intentional fallback: sweep is best-effort housekeeping; if the body can't
    // be parsed we fall through to defaults (timeoutHours=2). No user-facing impact.
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
