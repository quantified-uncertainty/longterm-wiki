import { Hono } from "hono";
import { z } from "zod";
import { eq, count, sql, desc } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { divisionPersonnel } from "../../schema.js";
import {
  paginationQuery,
  zv,
} from "../shared/utils.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { bulkQuery } from "../shared/bulk-query.js";
import { paginatedQuery } from "../shared/paginated-query.js";
import { createSyncHandler } from "./sync-factory.js";

// ---- Query schemas ----

const ScopedQuery = paginationQuery({ defaultLimit: 100 });
const AllQuery = paginationQuery({ defaultLimit: 200 });

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

    const { rows, total } = await paginatedQuery({
      query: db
        .select()
        .from(divisionPersonnel)
        .orderBy(desc(divisionPersonnel.syncedAt), desc(divisionPersonnel.id))
        .limit(limit)
        .offset(offset),
      countQuery: db.select({ count: count() }).from(divisionPersonnel),
      formatRow,
    });

    return c.json({
      divisionPersonnel: rows,
      total,
      limit,
      offset,
    });
  })

  // ---- GET /bulk ----
  // Returns every division-personnel row in a single response. QUA-1040.
  .get("/bulk", async (c) => {
    const db = getDrizzleDb();
    const { rows, total } = await bulkQuery({
      query: db
        .select()
        .from(divisionPersonnel)
        .orderBy(desc(divisionPersonnel.syncedAt), desc(divisionPersonnel.id)),
      formatRow,
      routeName: "division-personnel/bulk",
    });
    return c.json({ divisionPersonnel: rows, total });
  })

  // ---- GET /by-division/:divisionId ----
  .get(
    "/by-division/:divisionId",
    zv("query", ScopedQuery),
    async (c) => {
      const divisionId = c.req.param("divisionId");
      const { limit, offset } = c.req.valid("query");
      const db = getDrizzleDb();

      const where = eq(divisionPersonnel.divisionId, divisionId);

      const { rows, total } = await paginatedQuery({
        query: db
          .select()
          .from(divisionPersonnel)
          .where(where)
          .orderBy(desc(divisionPersonnel.syncedAt), desc(divisionPersonnel.id))
          .limit(limit)
          .offset(offset),
        countQuery: db.select({ count: count() }).from(divisionPersonnel).where(where),
        formatRow,
      });

      return c.json({
        divisionId,
        divisionPersonnel: rows,
        total,
        limit,
        offset,
      });
    }
  )

  // ---- GET /by-person/:personId ----
  .get("/by-person/:personId", zv("query", ScopedQuery), async (c) => {
    const personId = c.req.param("personId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const where = eq(divisionPersonnel.personId, personId);

    const { rows, total } = await paginatedQuery({
      query: db
        .select()
        .from(divisionPersonnel)
        .where(where)
        .orderBy(desc(divisionPersonnel.syncedAt), desc(divisionPersonnel.id))
        .limit(limit)
        .offset(offset),
      countQuery: db.select({ count: count() }).from(divisionPersonnel).where(where),
      formatRow,
    });

    return c.json({
      personId,
      divisionPersonnel: rows,
      total,
      limit,
      offset,
    });
  })

  // ---- POST /sync ----
  .post("/sync", createSyncHandler({
    name: "division-personnel",
    table: divisionPersonnel,
    syncSchema: SyncDivisionPersonnelItemSchema,
    entityRefs: ["personId"],
    naturalKey: (item) => item.id,
    naturalKeyError: "Duplicate id values in items array",
    conflictSet: {
      divisionId: sql`excluded.division_id`,
      personId: sql`excluded.person_id`,
      role: sql`excluded.role`,
      // COALESCE: preserve existing values when sync payload sends null
      startDate: sql`COALESCE(excluded.start_date, ${divisionPersonnel.startDate})`,
      endDate: sql`COALESCE(excluded.end_date, ${divisionPersonnel.endDate})`,
      source: sql`COALESCE(excluded.source, ${divisionPersonnel.source})`,
      notes: sql`COALESCE(excluded.notes, ${divisionPersonnel.notes})`,
      syncedAt: sql`now()`,
      updatedAt: sql`now()`,
    },
    toThing: (item) => ({
      id: item.id,
      thingType: "division-personnel" as const,
      parentThingId: item.divisionId,
      sourceTable: "division_personnel",
      sourceId: item.id,
      sourceUrl: item.source ?? null,
    }),
  }))

  .post("/delete-batch", deleteBatchHandler(divisionPersonnel, "division_personnel"));

// ---- Exports ----

export const divisionPersonnelRoute = divisionPersonnelApp;
export type DivisionPersonnelRoute = typeof divisionPersonnelApp;
