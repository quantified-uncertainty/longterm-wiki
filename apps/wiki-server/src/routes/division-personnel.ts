import { Hono } from "hono";
import { z } from "zod";
import { eq, count, sql, desc } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { divisionPersonnel } from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
} from "./utils.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

// ---- Query schemas ----

const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const AllQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Sync schema ----

const SyncDivisionPersonnelItemSchema = z.object({
  id: z.string().length(10),
  divisionId: z.string().min(1).max(200),
  personId: z.string().min(1).max(200),
  role: z.string().min(1).max(500),
  startDate: z.string().max(20).nullable().optional(),
  endDate: z.string().max(20).nullable().optional(),
  source: z.string().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const SyncDivisionPersonnelBatchSchema = z.object({
  items: z
    .array(SyncDivisionPersonnelItemSchema)
    .min(1)
    .max(500)
    .refine(
      (items) => new Set(items.map((i) => i.id)).size === items.length,
      { message: "Duplicate id values in items array" }
    ),
});

// ---- Helpers ----

function formatRow(r: typeof divisionPersonnel.$inferSelect) {
  return {
    id: r.id,
    divisionId: r.divisionId,
    personId: r.personId,
    role: r.role,
    startDate: r.startDate,
    endDate: r.endDate,
    source: r.source,
    notes: r.notes,
    syncedAt: r.syncedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ---- Route definition (method-chained for Hono RPC type inference) ----

const divisionPersonnelApp = new Hono()

  // ---- GET /stats ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const [statsRow] = await db
      .select({ total: count() })
      .from(divisionPersonnel);

    return c.json({ total: statsRow.total });
  })

  // ---- GET /all ----
  .get("/all", zv("query", AllQuery), async (c) => {
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(divisionPersonnel)
      .orderBy(desc(divisionPersonnel.syncedAt), desc(divisionPersonnel.id))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(divisionPersonnel);
    const total = countResult[0].count;

    return c.json({
      divisionPersonnel: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /by-division/:divisionId ----
  .get(
    "/by-division/:divisionId",
    zv("query", PaginationQuery),
    async (c) => {
      const divisionId = c.req.param("divisionId");
      const { limit, offset } = c.req.valid("query");
      const db = getDrizzleDb();

      const rows = await db
        .select()
        .from(divisionPersonnel)
        .where(eq(divisionPersonnel.divisionId, divisionId))
        .orderBy(desc(divisionPersonnel.syncedAt), desc(divisionPersonnel.id))
        .limit(limit)
        .offset(offset);

      const countResult = await db
        .select({ count: count() })
        .from(divisionPersonnel)
        .where(eq(divisionPersonnel.divisionId, divisionId));
      const total = countResult[0].count;

      return c.json({
        divisionId,
        divisionPersonnel: rows.map(formatRow),
        total,
        limit,
        offset,
      });
    }
  )

  // ---- GET /by-person/:personId ----
  .get("/by-person/:personId", zv("query", PaginationQuery), async (c) => {
    const personId = c.req.param("personId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(divisionPersonnel)
      .where(eq(divisionPersonnel.personId, personId))
      .orderBy(desc(divisionPersonnel.syncedAt), desc(divisionPersonnel.id))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(divisionPersonnel)
      .where(eq(divisionPersonnel.personId, personId));
    const total = countResult[0].count;

    return c.json({
      personId,
      divisionPersonnel: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- POST /sync ----
  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncDivisionPersonnelBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;
    const db = getDrizzleDb();

    let upserted = 0;

    await db.transaction(async (tx) => {
      const allVals = items.map((item) => ({
        id: item.id,
        divisionId: item.divisionId,
        personId: item.personId,
        role: item.role,
        startDate: item.startDate ?? null,
        endDate: item.endDate ?? null,
        source: item.source ?? null,
        notes: item.notes ?? null,
      }));

      await tx
        .insert(divisionPersonnel)
        .values(allVals)
        .onConflictDoUpdate({
          target: divisionPersonnel.id,
          set: {
            divisionId: sql`excluded.division_id`,
            personId: sql`excluded.person_id`,
            role: sql`excluded.role`,
            startDate: sql`excluded.start_date`,
            endDate: sql`excluded.end_date`,
            source: sql`excluded.source`,
            notes: sql`excluded.notes`,
            syncedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        });
      upserted = allVals.length;
    });

    return c.json({ upserted });
  });

// ---- Exports ----

export const divisionPersonnelRoute = divisionPersonnelApp;
export type DivisionPersonnelRoute = typeof divisionPersonnelApp;
