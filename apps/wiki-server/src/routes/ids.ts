import { Hono } from "hono";
import { z } from "zod";
import { eq, count, sql, asc } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { entityIds } from "../schema.js";

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
  const db = getDrizzleDb();

  // Check if slug already exists (avoids burning a sequence value on conflict)
  const existing = await db
    .select()
    .from(entityIds)
    .where(eq(entityIds.slug, slug));

  if (existing.length > 0) {
    const row = existing[0];
    return c.json({
      numericId: `E${row.numericId}`,
      slug: row.slug,
      description: row.description,
      created: false,
      createdAt: row.createdAt,
    });
  }

  // Slug is new — allocate next sequence value
  const inserted = await db
    .insert(entityIds)
    .values({
      numericId: sql`nextval('entity_id_seq')`,
      slug,
      description: description ?? null,
    })
    .onConflictDoNothing({ target: entityIds.slug })
    .returning();

  if (inserted.length > 0) {
    const row = inserted[0];
    return c.json(
      {
        numericId: `E${row.numericId}`,
        slug: row.slug,
        description: row.description,
        created: true,
        createdAt: row.createdAt,
      },
      201
    );
  }

  // Race condition: another request inserted between our SELECT and INSERT.
  // Re-fetch the existing row.
  const raced = await db
    .select()
    .from(entityIds)
    .where(eq(entityIds.slug, slug));

  if (raced.length === 0) {
    return c.json(
      { error: "not_found", message: "Unexpected: slug not found after conflict" },
      500
    );
  }

  const row = raced[0];
  return c.json({
    numericId: `E${row.numericId}`,
    slug: row.slug,
    description: row.description,
    created: false,
    createdAt: row.createdAt,
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
  const db = getDrizzleDb();
  const results: Array<{
    numericId: string;
    slug: string;
    description: string | null;
    created: boolean;
    createdAt: Date;
  }> = [];

  // Run all allocations in a single transaction
  await db.transaction(async (tx) => {
    for (const item of items) {
      // Check existence first to avoid burning sequence values
      const existing = await tx
        .select()
        .from(entityIds)
        .where(eq(entityIds.slug, item.slug));

      if (existing.length > 0) {
        const row = existing[0];
        results.push({
          numericId: `E${row.numericId}`,
          slug: row.slug,
          description: row.description,
          created: false,
          createdAt: row.createdAt,
        });
        continue;
      }

      const inserted = await tx
        .insert(entityIds)
        .values({
          numericId: sql`nextval('entity_id_seq')`,
          slug: item.slug,
          description: item.description ?? null,
        })
        .onConflictDoNothing({ target: entityIds.slug })
        .returning();

      if (inserted.length > 0) {
        const row = inserted[0];
        results.push({
          numericId: `E${row.numericId}`,
          slug: row.slug,
          description: row.description,
          created: true,
          createdAt: row.createdAt,
        });
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
  const db = getDrizzleDb();

  const rows = await db
    .select()
    .from(entityIds)
    .orderBy(asc(entityIds.numericId))
    .limit(limit)
    .offset(offset);

  const countResult = await db.select({ count: count() }).from(entityIds);
  const total = countResult[0].count;

  return c.json({
    ids: rows.map((r) => ({
      numericId: `E${r.numericId}`,
      slug: r.slug,
      description: r.description,
      createdAt: r.createdAt,
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

  const db = getDrizzleDb();
  const rows = await db
    .select()
    .from(entityIds)
    .where(eq(entityIds.slug, slug));

  if (rows.length === 0) {
    return c.json({ error: "not_found", message: `No ID for slug: ${slug}` }, 404);
  }

  const row = rows[0];
  return c.json({
    numericId: `E${row.numericId}`,
    slug: row.slug,
    description: row.description,
    createdAt: row.createdAt,
  });
});
