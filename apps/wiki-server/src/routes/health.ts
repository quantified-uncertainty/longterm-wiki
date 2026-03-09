import { Hono } from "hono";
import { count } from "drizzle-orm";
import { getDrizzleDb, getDb } from "../db.js";
import { entityIds, wikiPages, entities, facts } from "../schema.js";
import { logger } from "../logger.js";

const startTime = Date.now();

const healthApp = new Hono()
  .get("/", async (c) => {
    const db = getDrizzleDb();

    let dbStatus = "ok";
    let totalIds = 0;
    let nextId = 0;
    let totalPages = 0;
    let totalEntities = 0;
    let totalFacts = 0;

    try {
      const countResult = await db.select({ count: count() }).from(entityIds);
      totalIds = countResult[0].count;

      const pagesCountResult = await db
        .select({ count: count() })
        .from(wikiPages);
      totalPages = pagesCountResult[0].count;

      const entitiesCountResult = await db
        .select({ count: count() })
        .from(entities);
      totalEntities = entitiesCountResult[0].count;

      const factsCountResult = await db.select({ count: count() }).from(facts);
      totalFacts = factsCountResult[0].count;

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
      logger.error({ err }, "Health check DB error");
    }

    return c.json({
      status: dbStatus === "ok" ? "healthy" : "degraded",
      database: dbStatus,
      totalIds,
      totalPages,
      totalEntities,
      totalFacts,
      nextId,
      uptime: Math.floor((Date.now() - startTime) / 1000),
    });
  })
  /**
   * GET /auth — Check if a Bearer token is valid.
   * Returns 401 if no token or invalid token.
   */
  .get("/auth", (c) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Bearer token required" }, 401);
    }

    const token = authHeader.slice(7);
    const expectedKey = process.env.LONGTERMWIKI_SERVER_API_KEY;

    if (!expectedKey) {
      return c.json({ valid: true, keyConfigured: false });
    }

    if (token !== expectedKey) {
      return c.json({ error: "Invalid API key" }, 401);
    }

    return c.json({ valid: true, keyConfigured: true });
  });

export const healthRoute = healthApp;
export type HealthRoute = typeof healthApp;
