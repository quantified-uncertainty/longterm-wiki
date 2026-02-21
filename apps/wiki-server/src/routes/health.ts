import { Hono } from "hono";
import { count, sql } from "drizzle-orm";
import { getDrizzleDb, getDb } from "../db.js";
import { entityIds, wikiPages } from "../schema.js";

const startTime = Date.now();

export const healthRoute = new Hono();

healthRoute.get("/", async (c) => {
  const db = getDrizzleDb();

  let dbStatus = "ok";
  let totalIds = 0;
  let nextId = 0;
  let totalPages = 0;

  try {
    const countResult = await db.select({ count: count() }).from(entityIds);
    totalIds = countResult[0].count;

    const pagesCountResult = await db
      .select({ count: count() })
      .from(wikiPages);
    totalPages = pagesCountResult[0].count;

    // Sequence query — no Drizzle equivalent, use raw SQL
    const rawDb = getDb();
    const seqResult =
      await rawDb`SELECT last_value, is_called FROM entity_id_seq`;
    const lastValue = Number(seqResult[0].last_value);
    const isCalled = seqResult[0].is_called;
    // If is_called is false, nextval will return last_value itself
    nextId = isCalled ? lastValue + 1 : lastValue;
  } catch (err) {
    dbStatus = "error";
    console.error("Health check DB error:", err);
  }

  return c.json({
    status: dbStatus === "ok" ? "healthy" : "degraded",
    database: dbStatus,
    totalIds,
    totalPages,
    nextId,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
});
