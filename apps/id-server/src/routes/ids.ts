import { Hono } from "hono";
import { z } from "zod";
import { getDb, type SqlQuery } from "../db.js";

export const idsRoute = new Hono();

// ---- Schemas ----

const AllocateSchema = z.object({
  slug: z.string().min(1).max(500),
  description: z.string().max(2000).optional(),
});

const AllocateBatchSchema = z.object({
  items: z
    .array(
      z.object({
        slug: z.string().min(1).max(500),
        description: z.string().max(2000).optional(),
      })
    )
    .min(1)
    .max(50),
});

// ---- POST /allocate ----

idsRoute.post("/allocate", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json", message: "Request body must be valid JSON" }, 400);
  }
  const parsed = AllocateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "validation_error", message: parsed.error.message },
      400
    );
  }

  const { slug, description } = parsed.data;
  const db = getDb();

  // Try insert with nextval; on conflict (slug exists), return existing
  const inserted = await db`
    INSERT INTO entity_ids (numeric_id, slug, description)
    VALUES (nextval('entity_id_seq'), ${slug}, ${description ?? null})
    ON CONFLICT (slug) DO NOTHING
    RETURNING numeric_id, slug, description, created_at
  `;

  if (inserted.length > 0) {
    const row = inserted[0];
    return c.json(
      {
        numericId: `E${row.numeric_id}`,
        slug: row.slug,
        description: row.description,
        created: true,
        createdAt: row.created_at,
      },
      201
    );
  }

  // Already existed — fetch it
  const existing = await db`
    SELECT numeric_id, slug, description, created_at
    FROM entity_ids
    WHERE slug = ${slug}
  `;

  if (existing.length === 0) {
    return c.json(
      { error: "not_found", message: "Unexpected: slug not found after conflict" },
      500
    );
  }

  const row = existing[0];
  return c.json({
    numericId: `E${row.numeric_id}`,
    slug: row.slug,
    description: row.description,
    created: false,
    createdAt: row.created_at,
  });
});

// ---- POST /allocate-batch ----

idsRoute.post("/allocate-batch", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json", message: "Request body must be valid JSON" }, 400);
  }
  const parsed = AllocateBatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "validation_error", message: parsed.error.message },
      400
    );
  }

  const { items } = parsed.data;
  const db = getDb();
  const results: Array<{
    numericId: string;
    slug: string;
    description: string | null;
    created: boolean;
    createdAt: string;
  }> = [];

  // Run all allocations in a single transaction
  // Cast tx: TransactionSql's Omit drops Sql's call signatures (TS limitation)
  await db.begin(async (tx) => {
    const q = tx as unknown as SqlQuery;
    for (const item of items) {
      const inserted = await q`
        INSERT INTO entity_ids (numeric_id, slug, description)
        VALUES (nextval('entity_id_seq'), ${item.slug}, ${item.description ?? null})
        ON CONFLICT (slug) DO NOTHING
        RETURNING numeric_id, slug, description, created_at
      `;

      if (inserted.length > 0) {
        const row = inserted[0];
        results.push({
          numericId: `E${row.numeric_id}`,
          slug: row.slug,
          description: row.description,
          created: true,
          createdAt: row.created_at,
        });
      } else {
        const existing = await q`
          SELECT numeric_id, slug, description, created_at
          FROM entity_ids
          WHERE slug = ${item.slug}
        `;
        if (existing.length > 0) {
          const row = existing[0];
          results.push({
            numericId: `E${row.numeric_id}`,
            slug: row.slug,
            description: row.description,
            created: false,
            createdAt: row.created_at,
          });
        }
      }
    }
  });

  return c.json({ results });
});

// ---- GET / (list all, paginated) ----

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

idsRoute.get("/", async (c) => {
  const parsed = ListQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json(
      { error: "validation_error", message: parsed.error.message },
      400
    );
  }

  const { limit, offset } = parsed.data;
  const db = getDb();

  const rows = await db`
    SELECT numeric_id, slug, description, created_at
    FROM entity_ids
    ORDER BY numeric_id
    LIMIT ${limit} OFFSET ${offset}
  `;

  const countResult = await db`SELECT COUNT(*) AS count FROM entity_ids`;
  const total = Number(countResult[0].count);

  return c.json({
    ids: rows.map((r) => ({
      numericId: `E${r.numeric_id}`,
      slug: r.slug,
      description: r.description,
      createdAt: r.created_at,
    })),
    total,
    limit,
    offset,
  });
});

// ---- GET /by-slug?slug=... ----

idsRoute.get("/by-slug", async (c) => {
  const slug = c.req.query("slug");
  if (!slug) {
    return c.json(
      { error: "validation_error", message: "slug query parameter is required" },
      400
    );
  }

  const db = getDb();
  const rows = await db`
    SELECT numeric_id, slug, description, created_at
    FROM entity_ids
    WHERE slug = ${slug}
  `;

  if (rows.length === 0) {
    return c.json({ error: "not_found", message: `No ID for slug: ${slug}` }, 404);
  }

  const row = rows[0];
  return c.json({
    numericId: `E${row.numeric_id}`,
    slug: row.slug,
    description: row.description,
    createdAt: row.created_at,
  });
});
