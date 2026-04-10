import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { eq, count, sql, desc } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { divisionPersonnel } from "../../schema.js";
import {
  paginationQuery,
  noDuplicateIds,
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
} from "../shared/utils.js";
import { upsertThingsInTx } from "../shared/thing-sync.js";
import { validateEntityRefs } from "../shared/validate-entity-refs.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { createSyncHandler } from "./sync-factory.js";
import { useFactoryFor } from "./sync-factory-flag.js";

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

const SyncDivisionPersonnelBatchSchema = z.object({
  items: z
    .array(SyncDivisionPersonnelItemSchema)
    .min(1)
    .max(500)
    .refine(noDuplicateIds, { message: "Duplicate id values in items array" }),
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
  //
  // Phase 2 migration (issue #4090, discussion #4088): both factory and
  // legacy handlers coexist behind USE_SYNC_FACTORY_ROUTES feature flag.
  // After 7 days of clean metrics with the factory enabled (default), a
  // follow-up PR will remove `legacySyncHandler` and the conditional.
  //
  // Rollback: set `USE_SYNC_FACTORY_ROUTES=!division-personnel` to fall back
  // to the legacy handler instantly without redeploying.
  .post("/sync", async (c) => {
    if (useFactoryFor("division-personnel")) {
      return factorySyncHandler(c);
    }
    return legacySyncHandler(c);
  })

  .post("/delete-batch", deleteBatchHandler(divisionPersonnel, "division_personnel"));

// ---- Factory implementation (Phase 2 migration) ----

const factorySyncHandler = createSyncHandler({
  name: "division-personnel",
  table: divisionPersonnel,
  batchSchema: SyncDivisionPersonnelBatchSchema,
  entityRefFields: (items) => [
    { fieldName: "personId", ids: items.map((i) => i.personId) },
  ],
  toRow: (item) => ({
    id: item.id,
    divisionId: item.divisionId,
    personId: item.personId,
    role: item.role,
    startDate: item.startDate ?? null,
    endDate: item.endDate ?? null,
    source: item.source ?? null,
    notes: item.notes ?? null,
  }),
  // COALESCE preservation for nullable fields (route's only escape hatch).
  conflictSet: {
    divisionId: sql`excluded.division_id`,
    personId: sql`excluded.person_id`,
    role: sql`excluded.role`,
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
    title: `${item.personId} — ${item.role}`,
    sourceTable: "division_personnel",
    sourceId: item.id,
    sourceUrl: item.source,
  }),
});

// ---- Legacy sync handler (kept for 7-day soak window after Phase 2 migration) ----

async function legacySyncHandler(c: Context) {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = SyncDivisionPersonnelBatchSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { items } = parsed.data;
  const db = getDrizzleDb();

  // Validate entity FK references before inserting
  const refError = await validateEntityRefs(c, db, [
    { fieldName: "personId", ids: items.map((i) => i.personId) },
  ]);
  if (refError) return refError;

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
          // COALESCE: preserve existing values when sync payload sends null
          startDate: sql`COALESCE(excluded.start_date, ${divisionPersonnel.startDate})`,
          endDate: sql`COALESCE(excluded.end_date, ${divisionPersonnel.endDate})`,
          source: sql`COALESCE(excluded.source, ${divisionPersonnel.source})`,
          notes: sql`COALESCE(excluded.notes, ${divisionPersonnel.notes})`,
          syncedAt: sql`now()`,
          updatedAt: sql`now()`,
        },
      });

    // Dual-write to things table
    await upsertThingsInTx(
      tx,
      items.map((dp) => ({
        id: dp.id,
        thingType: "division-personnel" as const,
        title: `${dp.personId} — ${dp.role}`,
        sourceTable: "division_personnel",
        sourceId: dp.id,
        sourceUrl: dp.source,
      }))
    );

    upserted = allVals.length;
  });

  return c.json({ upserted });
}

// ---- Exports ----

export const divisionPersonnelRoute = divisionPersonnelApp;
export type DivisionPersonnelRoute = typeof divisionPersonnelApp;
