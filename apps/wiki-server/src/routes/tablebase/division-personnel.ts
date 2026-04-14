import { Hono } from "hono";
import { z } from "zod";
import { eq, count, sql, desc, inArray } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { divisionPersonnel, divisions } from "../../schema.js";
import {
  paginationQuery,
  zv,
} from "../shared/utils.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { createSyncHandler } from "./sync-factory.js";
import { registerComposer, composeThing } from "../shared/compose-thing.js";

// ---- QUA-470 Phase 4b-B.1: division-personnel composer ----
//
// Audit §6.5: division-personnel was leaking raw personId slug into titles
// (`<personId> — <role>`). Fix:
//   1. Add `thingsTitleIds` to pre-resolve person + division entity titles.
//   2. Compose via the registered composer with resolved names.
interface DivisionPersonnelComposerRow {
  personId: string;
  divisionId: string;
  role: string;
}

registerComposer<DivisionPersonnelComposerRow>(
  "division-personnel",
  (row, titleMap) => {
    const personName = titleMap.get(row.personId) ?? row.personId;
    const divisionName = titleMap.get(row.divisionId) ?? row.divisionId;
    return {
      title: `${personName} — ${row.role}`,
      description: null,
      parentTitle: divisionName,
    };
  },
);

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
    zv("query", ScopedQuery),
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
  .get("/by-person/:personId", zv("query", ScopedQuery), async (c) => {
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
    // QUA-470: personId resolves via entities, but divisionId points at the
    // divisions table. Use augmentTitleMap to fetch division names directly.
    thingsTitleIds: (items) => [...new Set(items.map((it) => it.personId))],
    augmentTitleMap: async (tx, items, titleMap) => {
      const divisionIds = [
        ...new Set(items.map((i) => i.divisionId)),
      ].filter((id): id is string => !!id);
      if (divisionIds.length === 0) return;
      const rows = await tx
        .select({ id: divisions.id, name: divisions.name })
        .from(divisions)
        .where(inArray(divisions.id, divisionIds));
      for (const r of rows) titleMap.set(r.id, r.name);
    },
    toThing: (item, titleMap) => {
      const composed = composeThing<DivisionPersonnelComposerRow>(
        "division-personnel",
        item,
        titleMap,
      );
      return {
        id: item.id,
        thingType: "division-personnel" as const,
        title: composed.title,
        description: composed.description,
        parentTitle: composed.parentTitle,
        sourceTable: "division_personnel",
        sourceId: item.id,
        sourceUrl: item.source ?? null,
      };
    },
  }))

  .post("/delete-batch", deleteBatchHandler(divisionPersonnel, "division_personnel"));

// ---- Exports ----

export const divisionPersonnelRoute = divisionPersonnelApp;
export type DivisionPersonnelRoute = typeof divisionPersonnelApp;
