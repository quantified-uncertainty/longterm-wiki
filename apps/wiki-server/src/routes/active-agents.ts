import { Hono } from "hono";
import { eq, desc, and, lt, sql } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { activeAgents } from "../schema.js";
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

/** Default minutes before an agent without heartbeat is marked stale. */
const STALE_TIMEOUT_MINUTES = 30;

const activeAgentsApp = new Hono()
  // ---- POST / (register a new agent) ----
  .post("/", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = RegisterAgentSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const d = parsed.data;
    const db = getDrizzleDb();

    // Upsert: if an agent with this sessionId already exists, update it
    const { row, isUpdate } = await db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(activeAgents)
        .where(eq(activeAgents.sessionId, d.sessionId))
        .limit(1);

      if (existing.length > 0) {
        const updated = await tx
          .update(activeAgents)
          .set({
            branch: d.branch ?? existing[0].branch,
            task: d.task,
            issueNumber: d.issueNumber ?? null,
            model: d.model ?? null,
            worktree: d.worktree ?? null,
            metadata: d.metadata ?? existing[0].metadata,
            status: "active",
            heartbeatAt: new Date(),
            completedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(activeAgents.id, existing[0].id))
          .returning();
        return { row: firstOrThrow(updated, "active agent update"), isUpdate: true };
      }

      const inserted = await tx
        .insert(activeAgents)
        .values({
          sessionId: d.sessionId,
          branch: d.branch ?? null,
          task: d.task,
          issueNumber: d.issueNumber ?? null,
          model: d.model ?? null,
          worktree: d.worktree ?? null,
          metadata: d.metadata ?? null,
        })
        .returning();
      return { row: firstOrThrow(inserted, "active agent insert"), isUpdate: false };
    });

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

    // Compute conflict warnings: agents working on the same issue
    const issueGroups = new Map<number, string[]>();
    for (const row of rows) {
      if (row.issueNumber && row.status === "active") {
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

    console.log(`[active-agents] Sweep: marked ${stale.length} agents as stale (cutoff: ${cutoff.toISOString()})`);

    return c.json({ swept: stale.length, agents: stale });
  });

export const activeAgentsRoute = activeAgentsApp;
export type ActiveAgentsRoute = typeof activeAgentsApp;
