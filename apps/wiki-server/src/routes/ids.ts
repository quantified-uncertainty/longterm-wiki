import { randomBytes } from "node:crypto";
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

/**
 * Generate a random 10-char alphanumeric stable ID.
 * Same algorithm as packages/kb/src/ids.ts — duplicated here to avoid
 * cross-package dependencies in the wiki-server build.
 */
function generateStableId(): string {
  const REPLACEMENT_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";
  const raw = randomBytes(7).toString("base64url").slice(0, 10);
  return raw
    .split("")
    .map((ch) => {
      if (ch === "-" || ch === "_") {
        const byte = randomBytes(1)[0];
        return REPLACEMENT_CHARS[byte % REPLACEMENT_CHARS.length];
      }
      return ch;
    })
    .join("");
}

// ---- Helpers ----

type EntityIdRow = {
  numericId: number;
  slug: string;
  stableId: string | null;
  description: string | null;
  createdAt: Date;
};

function formatIdResponse(row: EntityIdRow, created: boolean) {
  return {
    numericId: `E${row.numericId}`,
    slug: row.slug,
    stableId: row.stableId,
    description: row.description,
    created,
    createdAt: row.createdAt,
  };
}

function formatIdSummary(row: EntityIdRow) {
  return {
    numericId: `E${row.numericId}`,
    slug: row.slug,
    stableId: row.stableId,
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

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Routes ----

const idsApp = new Hono()
  // ---- POST /allocate ----
  .post("/allocate", async (c) => {
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

    // Slug is new — allocate next sequence value + stable ID
    const inserted = await db
      .insert(entityIds)
      .values({
        numericId: sql`nextval('entity_id_seq')`,
        slug,
        stableId: generateStableId(),
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
  })

  // ---- POST /allocate-batch ----
  .post("/allocate-batch", async (c) => {
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
            stableId: generateStableId(),
            description: item.description ?? null,
          })
          .onConflictDoNothing({ target: entityIds.slug })
          .returning();

        if (inserted.length > 0) {
          results.push(formatIdResponse(inserted[0], true));
        } else {
          // Race condition: another request inserted between our SELECT and INSERT.
          // Re-fetch the existing row.
          const raced = await tx
            .select()
            .from(entityIds)
            .where(eq(entityIds.slug, item.slug));
          if (raced.length > 0) {
            results.push(formatIdResponse(raced[0], false));
          }
        }
      }
    });

    return c.json({ results });
  })

  // ---- GET / (list all, paginated) ----
  .get("/", async (c) => {
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
  })

  // ---- POST /backfill-stable-ids ----
  // Batch-set stableIds for existing slugs (used for KB import and generating
  // stableIds for entities that were allocated before this column existed).
  .post("/backfill-stable-ids", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const schema = z.object({
      items: z.array(z.object({
        slug: z.string().min(1).max(500),
        stableId: z.string().regex(/^[A-Za-z0-9]{10}$/, "stableId must be 10 alphanumeric characters"),
      })).max(200).default([]),
      finalize: z.boolean().default(false),
    }).refine((v) => v.items.length > 0 || v.finalize, {
      message: "items must be non-empty unless finalize=true",
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items, finalize } = parsed.data;
    const db = getDrizzleDb();
    let updated = 0;
    let generated = 0;
    let totalMissing = 0;

    if (items.length > 0) {
      await db.transaction(async (tx) => {
        for (const item of items) {
          const result = await tx
            .update(entityIds)
            .set({ stableId: item.stableId })
            .where(eq(entityIds.slug, item.slug))
            .returning();
          if (result.length > 0) updated++;
        }
      });
    }

    // Only generate stableIds for remaining rows when finalize=true,
    // so multi-batch imports can set known IDs before generating the rest.
    if (finalize) {
      const missing = await db
        .select({ slug: entityIds.slug })
        .from(entityIds)
        .where(sql`${entityIds.stableId} IS NULL`);
      totalMissing = missing.length;

      if (missing.length > 0) {
        await db.transaction(async (tx) => {
          for (const row of missing) {
            await tx
              .update(entityIds)
              .set({ stableId: generateStableId() })
              .where(eq(entityIds.slug, row.slug));
            generated++;
          }
        });
      }
    }

    return c.json({ updated, generated, totalMissing });
  })

  // ---- GET /by-slug?slug=... ----
  .get("/by-slug", async (c) => {
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

export const idsRoute = idsApp;
export type IdsRoute = typeof idsApp;
