import { Hono } from "hono";
import { eq, desc, and, lt } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { logger } from "../logger.js";
import { agentSessions } from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  firstOrThrow,
} from "./utils.js";
import {
  CreateAgentSessionSchema,
  UpdateAgentSessionSchema,
} from "../api-types.js";

const agentSessionsApp = new Hono()
  // ---- POST / (create or update agent session by branch) ----
  .post("/", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = CreateAgentSessionSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const d = parsed.data;
    const db = getDrizzleDb();

    // Atomic upsert: wrap select+insert/update in a transaction.
    // Note: this uses READ COMMITTED (Drizzle default), not serializable.
    // Concurrent requests are unlikely in practice (one agent per branch).
    const { row, isUpdate } = await db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.branch, d.branch))
        .orderBy(desc(agentSessions.startedAt))
        .limit(1);

      if (existing.length > 0 && existing[0].status === "active") {
        const updated = await tx
          .update(agentSessions)
          .set({
            task: d.task,
            sessionType: d.sessionType,
            issueNumber: d.issueNumber ?? null,
            checklistMd: d.checklistMd,
            worktree: d.worktree ?? existing[0].worktree ?? null,
            updatedAt: new Date(),
          })
          .where(eq(agentSessions.id, existing[0].id))
          .returning();
        return { row: firstOrThrow(updated, "agent session update"), isUpdate: true };
      }

      const inserted = await tx
        .insert(agentSessions)
        .values({
          branch: d.branch,
          task: d.task,
          sessionType: d.sessionType,
          issueNumber: d.issueNumber ?? null,
          checklistMd: d.checklistMd,
          worktree: d.worktree ?? null,
        })
        .returning();
      return { row: firstOrThrow(inserted, "agent session insert"), isUpdate: false };
    });

    return c.json(row, isUpdate ? 200 : 201);
  })

  // ---- GET /by-branch/:branch (get latest session for a branch) ----
  .get("/by-branch/:branch", async (c) => {
    const branch = c.req.param("branch");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.branch, branch))
      .orderBy(desc(agentSessions.startedAt))
      .limit(1);

    if (rows.length === 0) {
      return c.json({ error: "not_found", message: `No session for branch: ${branch}` }, 404);
    }

    return c.json(rows[0]);
  })

  // ---- PATCH /:id (update checklist or status) ----
  .patch("/:id", async (c) => {
    const raw = c.req.param("id");
    const id = Number(raw);
    if (!Number.isInteger(id) || id < 1) return validationError(c, "Invalid session ID");

    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = UpdateAgentSessionSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { checklistMd, status, prUrl, prOutcome } = parsed.data;
    if (checklistMd === undefined && status === undefined && prUrl === undefined && prOutcome === undefined) {
      return validationError(c, "At least one of checklistMd, status, prUrl, or prOutcome must be provided");
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (checklistMd !== undefined) updates.checklistMd = checklistMd;
    if (status !== undefined) {
      updates.status = status;
      if (status === "completed") {
        updates.completedAt = new Date();
      }
    }
    if (prUrl !== undefined) updates.prUrl = prUrl;
    if (prOutcome !== undefined) updates.prOutcome = prOutcome;

    const db = getDrizzleDb();
    const result = await db
      .update(agentSessions)
      .set(updates)
      .where(eq(agentSessions.id, id))
      .returning();

    if (result.length === 0) {
      return c.json({ error: "not_found", message: `No session with id: ${id}` }, 404);
    }

    return c.json(result[0]);
  })

  // ---- GET / (list recent sessions) ----
  .get("/", async (c) => {
    const limit = Math.min(Number(c.req.query("limit") || 50), 200);
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(agentSessions)
      .orderBy(desc(agentSessions.startedAt))
      .limit(limit);

    return c.json({ sessions: rows });
  })

  // ---- POST /sweep (mark stale active sessions as completed) ----
  .post("/sweep", async (c) => {
    const body = await parseJsonBody(c).catch(() => ({}));
    const raw = Number((body as Record<string, unknown>)?.timeoutHours || 2);
    const timeoutHours = Math.max(1, Math.min(Number.isFinite(raw) ? raw : 2, 720));

    const cutoff = new Date(Date.now() - timeoutHours * 60 * 60 * 1000);
    const db = getDrizzleDb();

    const stale = await db
      .update(agentSessions)
      .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(agentSessions.status, "active"),
          lt(agentSessions.updatedAt, cutoff)
        )
      )
      .returning({ id: agentSessions.id, branch: agentSessions.branch, issueNumber: agentSessions.issueNumber });

    logger.info({ swept: stale.length, cutoff: cutoff.toISOString() }, "Sweep: marked stale sessions as completed");

    return c.json({ swept: stale.length, sessions: stale });
  });

export const agentSessionsRoute = agentSessionsApp;
export type AgentSessionsRoute = typeof agentSessionsApp;
