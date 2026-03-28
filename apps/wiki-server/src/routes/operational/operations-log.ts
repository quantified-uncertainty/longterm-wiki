import { Hono } from "hono";
import { desc } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { operationsLog } from "../../schema.js";
import { zv } from "../shared/utils.js";
import { z } from "zod";

const CreateOperationSchema = z.object({
  description: z.string().trim().min(1),
  prNumber: z.number().int().positive().optional(),
  agentSessionId: z.number().int().positive().optional(),
  operator: z.string().trim().min(1).default("agent"),
  metadata: z.record(z.unknown()).optional(),
});

const operationsLogApp = new Hono()
  .get("/", async (c) => {
    const db = getDrizzleDb();
    const raw = parseInt(c.req.query("limit") ?? "50", 10);
    const limit = Math.min(Math.max(Number.isNaN(raw) || raw < 1 ? 50 : raw, 1), 200);

    const rows = await db
      .select()
      .from(operationsLog)
      .orderBy(desc(operationsLog.createdAt))
      .limit(limit);

    return c.json({ operations: rows });
  })

  .post("/", zv("json", CreateOperationSchema), async (c) => {
    const body = c.req.valid("json");
    const db = getDrizzleDb();

    const [row] = await db
      .insert(operationsLog)
      .values({
        description: body.description,
        prNumber: body.prNumber ?? null,
        agentSessionId: body.agentSessionId ?? null,
        operator: body.operator,
        metadata: body.metadata ?? null,
      })
      .returning();

    return c.json({ operation: row }, 201);
  });

export const operationsLogRoute = operationsLogApp;
export type OperationsLogRoute = typeof operationsLogApp;
