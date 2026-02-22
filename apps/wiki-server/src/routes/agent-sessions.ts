import { Hono } from "hono";
import { eq, desc, sql } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { agentSessions } from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
} from "./utils.js";
import {
  CreateAgentSessionSchema,
  UpdateAgentSessionSchema,
} from "../api-types.js";

export const agentSessionsRoute = new Hono();

// ---- POST / (create or update agent session by branch) ----

agentSessionsRoute.post("/", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = CreateAgentSessionSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const d = parsed.data;
  const db = getDrizzleDb();

  // Upsert: if a session for this branch already exists and is active, update it
  const existing = await db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.branch, d.branch))
    .orderBy(desc(agentSessions.startedAt))
    .limit(1);

  if (existing.length > 0 && existing[0].status === "active") {
    // Update existing active session
    const updated = await db
      .update(agentSessions)
      .set({
        task: d.task,
        sessionType: d.sessionType,
        issueNumber: d.issueNumber ?? null,
        checklistMd: d.checklistMd,
        updatedAt: new Date(),
      })
      .where(eq(agentSessions.id, existing[0].id))
      .returning();

    return c.json(updated[0], 200);
  }

  // Create new session
  const result = await db
    .insert(agentSessions)
    .values({
      branch: d.branch,
      task: d.task,
      sessionType: d.sessionType,
      issueNumber: d.issueNumber ?? null,
      checklistMd: d.checklistMd,
    })
    .returning();

  return c.json(result[0], 201);
});

// ---- GET /by-branch/:branch (get latest session for a branch) ----

agentSessionsRoute.get("/by-branch/:branch", async (c) => {
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
});

// ---- PATCH /:id (update checklist or status) ----

agentSessionsRoute.patch("/:id", async (c) => {
  const raw = c.req.param("id");
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) return validationError(c, "Invalid session ID");

  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = UpdateAgentSessionSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { checklistMd, status } = parsed.data;
  if (checklistMd === undefined && status === undefined) {
    return validationError(c, "At least one of checklistMd or status must be provided");
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (checklistMd !== undefined) updates.checklistMd = checklistMd;
  if (status !== undefined) {
    updates.status = status;
    if (status === "completed") {
      updates.completedAt = new Date();
    }
  }

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
});

// ---- GET / (list recent sessions) ----

agentSessionsRoute.get("/", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") || 50), 200);
  const db = getDrizzleDb();

  const rows = await db
    .select()
    .from(agentSessions)
    .orderBy(desc(agentSessions.startedAt))
    .limit(limit);

  return c.json({ sessions: rows });
});
