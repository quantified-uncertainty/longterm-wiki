import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { db, sql } from "./db.ts";
import { entityIds, editLogs } from "./schema.ts";
import { eq, desc, sql as dsql } from "drizzle-orm";

const app = new Hono();

app.use(logger());

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

app.get("/health", (c) => c.json({ ok: true }));

// ---------------------------------------------------------------------------
// Entity IDs
// ---------------------------------------------------------------------------

/**
 * POST /api/ids/next
 * Atomically allocate the next E ID for a given slug.
 *
 * Body: { slug: string, entityType?: string, title?: string }
 * Returns: { numericId: "E123", slug: "the-slug" }
 *
 * If the slug already has an ID, returns the existing one (idempotent).
 */
app.post("/api/ids/next", async (c) => {
  const body = await c.req.json<{
    slug: string;
    entityType?: string;
    title?: string;
  }>();

  if (!body.slug) {
    return c.json({ error: "slug is required" }, 400);
  }

  // Atomic upsert: INSERT with sequence value, ON CONFLICT return existing.
  // This avoids the TOCTOU race where two concurrent requests for the same
  // slug could both pass a SELECT check and then collide on INSERT.
  const [row] = await sql`
    WITH new_row AS (
      INSERT INTO entity_ids (numeric_id, slug, entity_type, title)
      VALUES (nextval('entity_id_seq'), ${body.slug}, ${body.entityType ?? null}, ${body.title ?? null})
      ON CONFLICT (slug) DO NOTHING
      RETURNING numeric_id, slug, FALSE AS already_existed
    )
    SELECT * FROM new_row
    UNION ALL
    SELECT numeric_id, slug, TRUE AS already_existed
    FROM entity_ids
    WHERE slug = ${body.slug}
      AND NOT EXISTS (SELECT 1 FROM new_row)
  `;

  return c.json(
    {
      numericId: `E${row.numeric_id}`,
      slug: row.slug,
      alreadyExisted: row.already_existed,
    },
    row.already_existed ? 200 : 201,
  );
});

/**
 * GET /api/ids
 * List all registered entity IDs.
 * Query params: ?limit=100&offset=0
 */
app.get("/api/ids", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 500, 1), 5000);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);

  const rows = await db
    .select()
    .from(entityIds)
    .orderBy(entityIds.numericId)
    .limit(limit)
    .offset(offset);

  const [{ count }] = await db
    .select({ count: dsql<number>`count(*)::int` })
    .from(entityIds);

  return c.json({ rows, total: count, limit, offset });
});

/**
 * GET /api/ids/:slug
 * Look up the numeric ID for a slug.
 */
app.get("/api/ids/:slug", async (c) => {
  const slug = c.req.param("slug");
  const rows = await db
    .select()
    .from(entityIds)
    .where(eq(entityIds.slug, slug))
    .limit(1);

  if (rows.length === 0) {
    return c.json({ error: "not found" }, 404);
  }

  const { numericId, ...rest } = rows[0];
  return c.json({ numericId: `E${numericId}`, ...rest });
});

// ---------------------------------------------------------------------------
// Edit Logs
// ---------------------------------------------------------------------------

/**
 * POST /api/edit-logs
 * Append an edit-log entry.
 *
 * Body: { pageId, date?, tool, agency, requestedBy?, note? }
 */
app.post("/api/edit-logs", async (c) => {
  const body = await c.req.json<{
    pageId: string;
    date?: string;
    tool: string;
    agency: string;
    requestedBy?: string;
    note?: string;
  }>();

  if (!body.pageId || !body.tool || !body.agency) {
    return c.json({ error: "pageId, tool, and agency are required" }, 400);
  }

  const [inserted] = await db
    .insert(editLogs)
    .values({
      pageId: body.pageId,
      date: body.date ?? new Date().toISOString().split("T")[0],
      tool: body.tool,
      agency: body.agency,
      requestedBy: body.requestedBy ?? null,
      note: body.note ?? null,
    })
    .returning();

  return c.json(inserted, 201);
});

/**
 * GET /api/edit-logs/:pageId
 * Get the full edit history for a page, newest first.
 */
app.get("/api/edit-logs/:pageId", async (c) => {
  const pageId = c.req.param("pageId");

  const rows = await db
    .select()
    .from(editLogs)
    .where(eq(editLogs.pageId, pageId))
    .orderBy(desc(editLogs.date), desc(editLogs.id));

  return c.json({ pageId, entries: rows });
});

/**
 * GET /api/edit-logs
 * List recent edit-log entries across all pages.
 * Query params: ?limit=100&offset=0
 */
app.get("/api/edit-logs", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 100, 1), 1000);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);

  const rows = await db
    .select()
    .from(editLogs)
    .orderBy(desc(editLogs.date), desc(editLogs.id))
    .limit(limit)
    .offset(offset);

  return c.json({ entries: rows, limit, offset });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const port = Number(process.env.PORT ?? 3002);

serve({ fetch: app.fetch, port }, () => {
  console.log(`Wiki server running on http://localhost:${port}`);
});
