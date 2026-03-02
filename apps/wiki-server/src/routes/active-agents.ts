import { Hono } from "hono";
import { eq, desc, and, lt, sql, or } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { activeAgents, agentSessionEvents } from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  firstOrThrow,
} from "./utils.js";
import {
  RegisterAgentSchema,
  UpdateAgentSchema,
} from "../api-types.js";
import { logger } from "../logger.js";
import { generateSessionName } from "../session-name.js";

/** Default minutes before an agent without heartbeat is marked stale. */
const STALE_TIMEOUT_MINUTES = 30;

/** Days after which completed/errored/stale agents are deleted by cleanup. */
const CLEANUP_AGE_DAYS = 30;

const activeAgentsApp = new Hono()
  // ---- POST / (register a new agent) ----
  .post("/", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = RegisterAgentSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const d = parsed.data;
    const db = getDrizzleDb();

    // Atomic upsert using INSERT ... ON CONFLICT to avoid race conditions.
    // Two agents registering with the same sessionId simultaneously will both
    // succeed — one inserts, the other updates via the conflict clause.
    // This replaces the previous SELECT-then-INSERT/UPDATE transaction pattern
    // which was vulnerable to TOCTOU races under concurrent heartbeats.
    const rows = await db
      .insert(activeAgents)
      .values({
        sessionId: d.sessionId,
        sessionName: generateSessionName(),
        branch: d.branch ?? null,
        task: d.task,
        issueNumber: d.issueNumber ?? null,
        model: d.model ?? null,
        worktree: d.worktree ?? null,
        metadata: d.metadata ?? null,
      })
      .onConflictDoUpdate({
        target: activeAgents.sessionId,
        set: {
          // For branch and metadata: prefer incoming value, fall back to existing
          branch: sql`coalesce(excluded.branch, "active_agents"."branch")`,
          // Keep existing session name if set; otherwise use the newly generated one
          sessionName: sql`coalesce("active_agents"."session_name", excluded.session_name)`,
          task: sql`excluded.task`,
          issueNumber: sql`excluded.issue_number`,
          model: sql`excluded.model`,
          worktree: sql`excluded.worktree`,
          metadata: sql`coalesce(excluded.metadata, "active_agents"."metadata")`,
          status: sql`'active'`,
          heartbeatAt: sql`now()`,
          completedAt: sql`null`,
          updatedAt: sql`now()`,
        },
      })
      .returning();

    const row = firstOrThrow(rows, "active agent upsert");

    // Determine if this was an insert or update by checking whether
    // created_at and updated_at differ (update sets updated_at to now(),
    // while insert sets both created_at and updated_at to defaultNow()).
    const isUpdate = row.createdAt.getTime() !== row.updatedAt.getTime();

    return c.json(row, isUpdate ? 200 : 201);
  })

  // ---- GET / (list agents, optionally filtered by status) ----
  .get("/", async (c) => {
    const status = c.req.query("status"); // optional: "active", "completed", etc.
    const limit = Math.min(Number(c.req.query("limit") || 50), 200);
    const db = getDrizzleDb();

    const conditions = status ? eq(activeAgents.status, status) : undefined;

    const rows = await db
      .select()
      .from(activeAgents)
      .where(conditions)
      .orderBy(desc(activeAgents.startedAt))
      .limit(limit);

    // Compute conflict warnings: agents working on the same issue.
    // Include both "active" and "stale" agents — a stale agent may still be
    // running (just missed a heartbeat), so picking up its issue risks conflicts.
    const issueGroups = new Map<number, string[]>();
    for (const row of rows) {
      if (row.issueNumber && (row.status === "active" || row.status === "stale")) {
        const group = issueGroups.get(row.issueNumber) || [];
        group.push(row.sessionId);
        issueGroups.set(row.issueNumber, group);
      }
    }
    const conflicts: Array<{ issueNumber: number; sessionIds: string[] }> = [];
    for (const [issueNumber, sessionIds] of issueGroups) {
      if (sessionIds.length > 1) {
        conflicts.push({ issueNumber, sessionIds });
      }
    }

    return c.json({ agents: rows, conflicts });
  })

  // ---- GET /:id (get a specific agent) ----
  .get("/:id", async (c) => {
    const raw = c.req.param("id");
    const id = Number(raw);
    if (!Number.isInteger(id) || id < 1) return validationError(c, "Invalid agent ID");

    const db = getDrizzleDb();
    const rows = await db
      .select()
      .from(activeAgents)
      .where(eq(activeAgents.id, id))
      .limit(1);

    if (rows.length === 0) {
      return c.json({ error: "not_found", message: `No agent with id: ${id}` }, 404);
    }

    return c.json(rows[0]);
  })

  // ---- PATCH /:id (update agent status, step, files, etc.) ----
  .patch("/:id", async (c) => {
    const raw = c.req.param("id");
    const id = Number(raw);
    if (!Number.isInteger(id) || id < 1) return validationError(c, "Invalid agent ID");

    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = UpdateAgentSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const d = parsed.data;
    const updates: Record<string, unknown> = {
      updatedAt: new Date(),
      heartbeatAt: new Date(), // any update counts as a heartbeat
    };

    if (d.status !== undefined) {
      updates.status = d.status;
      if (d.status === "completed" || d.status === "errored") {
        updates.completedAt = new Date();
      }
    }
    if (d.currentStep !== undefined) updates.currentStep = d.currentStep;
    if (d.branch !== undefined) updates.branch = d.branch;
    if (d.issueNumber !== undefined) updates.issueNumber = d.issueNumber;
    if (d.prNumber !== undefined) updates.prNumber = d.prNumber;
    if (d.filesTouched !== undefined) updates.filesTouched = d.filesTouched;
    if (d.metadata !== undefined) updates.metadata = d.metadata;

    const db = getDrizzleDb();
    const result = await db
      .update(activeAgents)
      .set(updates)
      .where(eq(activeAgents.id, id))
      .returning();

    if (result.length === 0) {
      return c.json({ error: "not_found", message: `No agent with id: ${id}` }, 404);
    }

    return c.json(result[0]);
  })

  // ---- POST /:id/heartbeat (quick heartbeat update) ----
  .post("/:id/heartbeat", async (c) => {
    const raw = c.req.param("id");
    const id = Number(raw);
    if (!Number.isInteger(id) || id < 1) return validationError(c, "Invalid agent ID");

    const db = getDrizzleDb();
    const result = await db
      .update(activeAgents)
      .set({ heartbeatAt: new Date(), updatedAt: new Date() })
      .where(eq(activeAgents.id, id))
      .returning();

    if (result.length === 0) {
      return c.json({ error: "not_found", message: `No agent with id: ${id}` }, 404);
    }

    return c.json({ ok: true, heartbeatAt: result[0].heartbeatAt });
  })

  // ---- POST /sweep (mark stale agents) ----
  .post("/sweep", async (c) => {
    const body = await parseJsonBody(c).catch(() => ({}));
    const raw = Number((body as Record<string, unknown>)?.timeoutMinutes || STALE_TIMEOUT_MINUTES);
    const timeoutMinutes = Math.max(5, Math.min(Number.isFinite(raw) ? raw : STALE_TIMEOUT_MINUTES, 43200));

    const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000);
    const db = getDrizzleDb();

    const stale = await db
      .update(activeAgents)
      .set({ status: "stale", updatedAt: new Date() })
      .where(
        and(
          eq(activeAgents.status, "active"),
          lt(activeAgents.heartbeatAt, cutoff)
        )
      )
      .returning({ id: activeAgents.id, sessionId: activeAgents.sessionId });

    logger.info({ swept: stale.length, cutoff: cutoff.toISOString() }, "Sweep: marked agents as stale");

    return c.json({ swept: stale.length, agents: stale });
  })

  // ---- POST /cleanup (delete old completed/errored/stale agents) ----
  .post("/cleanup", async (c) => {
    const body = await parseJsonBody(c).catch(() => ({}));
    const raw = Number((body as Record<string, unknown>)?.ageDays || CLEANUP_AGE_DAYS);
    const ageDays = Math.max(1, Math.min(Number.isFinite(raw) ? raw : CLEANUP_AGE_DAYS, 365));

    const cutoff = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
    const db = getDrizzleDb();

    // Clean up old events first (events older than the cutoff, regardless of agent status).
    // Note: events belonging to deleted agents are also cascade-deleted via FK,
    // but this catches old events on still-active agents too.
    const deletedEvents = await db
      .delete(agentSessionEvents)
      .where(lt(agentSessionEvents.timestamp, cutoff))
      .returning({ id: agentSessionEvents.id });

    // Only delete agents that are no longer active and are older than the cutoff
    const deleted = await db
      .delete(activeAgents)
      .where(
        and(
          or(
            eq(activeAgents.status, "completed"),
            eq(activeAgents.status, "errored"),
            eq(activeAgents.status, "stale")
          ),
          lt(activeAgents.updatedAt, cutoff)
        )
      )
      .returning({ id: activeAgents.id, sessionId: activeAgents.sessionId });

    logger.info(
      { deleted: deleted.length, deletedEvents: deletedEvents.length, ageDays, cutoff: cutoff.toISOString() },
      "Cleanup: deleted old agents and events"
    );

    return c.json({ deleted: deleted.length, deletedEvents: deletedEvents.length, agents: deleted });
  });

export const activeAgentsRoute = activeAgentsApp;
export type ActiveAgentsRoute = typeof activeAgentsApp;
