import { Hono } from "hono";
import { eq, desc } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { agentSessionEvents } from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  firstOrThrow,
} from "./utils.js";
import { CreateAgentEventSchema } from "../api-types.js";

const agentSessionEventsApp = new Hono()
  // ---- POST / (append an event) ----
  .post("/", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = CreateAgentEventSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const d = parsed.data;
    const db = getDrizzleDb();

    const inserted = await db
      .insert(agentSessionEvents)
      .values({
        agentId: d.agentId,
        eventType: d.eventType,
        message: d.message,
        metadata: d.metadata ?? null,
      })
      .returning();

    return c.json(firstOrThrow(inserted, "agent session event insert"), 201);
  })

  // ---- GET /by-agent/:agentId (list events for an agent) ----
  .get("/by-agent/:agentId", async (c) => {
    const raw = c.req.param("agentId");
    const agentId = Number(raw);
    if (!Number.isInteger(agentId) || agentId < 1) {
      return validationError(c, "Invalid agent ID");
    }

    const limit = Math.min(Number(c.req.query("limit") || 200), 500);
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(agentSessionEvents)
      .where(eq(agentSessionEvents.agentId, agentId))
      .orderBy(desc(agentSessionEvents.timestamp))
      .limit(limit);

    return c.json({ events: rows });
  });

export const agentSessionEventsRoute = agentSessionEventsApp;
export type AgentSessionEventsRoute = typeof agentSessionEventsApp;
