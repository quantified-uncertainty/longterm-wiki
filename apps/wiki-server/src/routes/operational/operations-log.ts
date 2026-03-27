import { Hono } from "hono";
import { desc } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { operationsLog } from "../../schema.js";
import { zv } from "../shared/utils.js";
import { z } from "zod";

const CreateOperationSchema = z.object({
  description: z.string().min(1),
  prNumber: z.number().int().optional(),
  agentSessionId: z.number().int().optional(),
  operator: z.string().default("agent"),
  metadata: z.record(z.unknown()).optional(),
});

const operationsLogApp = new Hono()
  .get("/", async (c) => {
    const db = getDrizzleDb();
    const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);

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
