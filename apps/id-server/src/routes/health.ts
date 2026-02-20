import { Hono } from "hono";
import { getDb } from "../db.js";

const startTime = Date.now();

export const healthRoute = new Hono();

healthRoute.get("/", async (c) => {
  const db = getDb();

  let dbStatus = "ok";
  let totalIds = 0;
  let nextId = 0;

  try {
    const countResult = await db`SELECT COUNT(*) AS count FROM entity_ids`;
    totalIds = Number(countResult[0].count);

    const seqResult =
      await db`SELECT last_value, is_called FROM entity_id_seq`;
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
    nextId,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
});
