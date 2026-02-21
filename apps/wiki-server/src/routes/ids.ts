import { Hono } from "hono";
import { z } from "zod";
import { eq, count, sql, asc } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { entityIds } from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  notFoundError,
} from "./utils.js";

export const idsRoute = new Hono();

// ---- Helpers ----

type EntityIdRow = {
  numericId: number;
  slug: string;
  description: string | null;
  createdAt: Date;
};

function formatIdResponse(row: EntityIdRow, created: boolean) {
  return {
    numericId: `E${row.numericId}`,
    slug: row.slug,
    description: row.description,
    created,
    createdAt: row.createdAt,
  };
}

function formatIdSummary(row: EntityIdRow) {
  return {
    numericId: `E${row.numericId}`,
    slug: row.slug,
    description: row.description,
    createdAt: row.createdAt,
  };
}

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
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = AllocateSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { slug, description } = parsed.data;
  const db = getDrizzleDb();

  // Check if slug already exists (avoids burning a sequence value on conflict)
  const existing = await db
    .select()
    .from(entityIds)
    .where(eq(entityIds.slug, slug));

  if (existing.length > 0) {
    return c.json(formatIdResponse(existing[0], false));
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
    return c.json(formatIdResponse(inserted[0], true), 201);
  }

  // Race condition: another request inserted between our SELECT and INSERT.
  // Re-fetch the existing row.
  const raced = await db
    .select()
    .from(entityIds)
    .where(eq(entityIds.slug, slug));

  if (raced.length === 0) {
    return c.json(
      { error: "internal_error", message: "Unexpected: slug not found after conflict" },
      500
    );
  }

  return c.json(formatIdResponse(raced[0], false));
});

// ---- POST /allocate-batch ----

idsRoute.post("/allocate-batch", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = AllocateBatchSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { items } = parsed.data;
  const db = getDrizzleDb();
  const results: ReturnType<typeof formatIdResponse>[] = [];

  // Run all allocations in a single transaction
  await db.transaction(async (tx) => {
    for (const item of items) {
      // Check existence first to avoid burning sequence values
      const existing = await tx
        .select()
        .from(entityIds)
        .where(eq(entityIds.slug, item.slug));

      if (existing.length > 0) {
        results.push(formatIdResponse(existing[0], false));
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
        results.push(formatIdResponse(inserted[0], true));
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
  if (!parsed.success) return validationError(c, parsed.error.message);

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
    ids: rows.map(formatIdSummary),
    total,
    limit,
    offset,
  });
});

// ---- GET /by-slug?slug=... ----

idsRoute.get("/by-slug", async (c) => {
  const slug = c.req.query("slug");
  if (!slug) return validationError(c, "slug query parameter is required");

  const db = getDrizzleDb();
  const rows = await db
    .select()
    .from(entityIds)
    .where(eq(entityIds.slug, slug));

  if (rows.length === 0) {
    return notFoundError(c, `No ID for slug: ${slug}`);
  }

  return c.json(formatIdSummary(rows[0]));
});
