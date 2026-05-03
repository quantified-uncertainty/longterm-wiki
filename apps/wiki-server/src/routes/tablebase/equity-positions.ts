import { Hono } from "hono";
import { z } from "zod";
import { eq, count, desc, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDrizzleDb } from "../../db.js";
import { equityPositions, entities } from "../../schema.js";
import {
  zv,
  parseRange,
  clampedLimit,
} from "../shared/utils.js";
import { bulkQuery } from "../shared/bulk-query.js";
import { paginatedQuery } from "../shared/paginated-query.js";
import { resolveEntityId, type ResolvedEntityVars } from "../shared/resolve-entity-middleware.js";
import { formatEntityRef } from "../shared/entity-ref.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { createSyncHandler } from "./sync-factory.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

// ---- Query schemas ----

const ByEntityQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 100),
  offset: z.coerce.number().int().min(0).default(0),
});

const AllQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 200),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Sync schema ----

const SyncEquityPositionItemSchema = z.object({
  id: z.string().length(10),
  companyId: z.string().min(1).max(200),
  holderId: z.string().min(1).max(200),
  stake: z.string().max(200).nullable().optional(),
  source: z.string().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  asOf: z.string().max(20).nullable().optional(),
  validEnd: z.string().max(20).nullable().optional(),
});

const SyncEquityPositionsBatchSchema = z.object({
  items: z.array(SyncEquityPositionItemSchema).min(1).max(500),
});

// ---- Helpers ----

const holderEntity = alias(entities, "holder_entity");
const companyEntity = alias(entities, "company_entity");

/** Selection shape for equity_positions + joined entity titles + slugs. */
const joinedSelect = {
  equityPositions: equityPositions,
  holderTitle: holderEntity.title,
  holderSlug: holderEntity.id,
  companyTitle: companyEntity.title,
  companySlug: companyEntity.id,
};

interface JoinedRow {
  equityPositions: typeof equityPositions.$inferSelect;
  holderTitle: string | null;
  holderSlug: string | null;
  companyTitle: string | null;
  companySlug: string | null;
}

function formatRow(r: JoinedRow) {
  const ep = r.equityPositions;
  const holderRef = formatEntityRef(ep.holderEntityId, r.holderSlug, r.holderTitle, ep.holderDisplayName, ep.holderId);
  const companyRef = formatEntityRef(ep.companyEntityId, r.companySlug, r.companyTitle, ep.companyDisplayName, ep.companyId);
  return {
    id: ep.id,
    companyId: ep.companyId,
    holderId: ep.holderId,
    stake: ep.stake,
    stakeLow: ep.stakeLow != null ? Number(ep.stakeLow) : null,
    stakeHigh: ep.stakeHigh != null ? Number(ep.stakeHigh) : null,
    source: ep.source,
    notes: ep.notes,
    asOf: ep.asOf,
    validEnd: ep.validEnd,
    // Structured entity refs
    holder: holderRef,
    company: companyRef,
    // Legacy flat fields (for backward compat)
    holderEntityId: ep.holderEntityId,
    holderDisplayName: ep.holderDisplayName,
    holderResolvedName: holderRef.name,
    companyEntityId: ep.companyEntityId,
    companyDisplayName: ep.companyDisplayName,
    companyResolvedName: companyRef.name,
    syncedAt: ep.syncedAt,
    createdAt: ep.createdAt,
    updatedAt: ep.updatedAt,
  };
}

// ---- Route definition (method-chained for Hono RPC type inference) ----

const equityPositionsApp = new Hono<{ Variables: ResolvedEntityVars }>()

  // ---- GET /stats ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const [statsRow] = await db
      .select({
        total: count(),
        uniqueCompanies: sql<number>`count(distinct ${equityPositions.companyId})`,
        uniqueHolders: sql<number>`count(distinct ${equityPositions.holderId})`,
      })
      .from(equityPositions);

    return c.json({
      total: statsRow.total,
      uniqueCompanies: Number(statsRow.uniqueCompanies),
      uniqueHolders: Number(statsRow.uniqueHolders),
    });
  })

  // ---- GET /all ----
  .get("/all", zv("query", AllQuery), async (c) => {
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const { rows, total } = await paginatedQuery({
      query: db
        .select(joinedSelect)
        .from(equityPositions)
        .leftJoin(holderEntity, eq(equityPositions.holderEntityId, holderEntity.stableId))
        .leftJoin(companyEntity, eq(equityPositions.companyEntityId, companyEntity.stableId))
        .orderBy(desc(equityPositions.syncedAt), equityPositions.id)
        .limit(limit)
        .offset(offset),
      countQuery: db.select({ count: count() }).from(equityPositions),
      formatRow,
    });

    return c.json({
      equityPositions: rows,
      total,
      limit,
      offset,
    });
  })

  // ---- GET /bulk ----
  // Returns every equity position in a single response. QUA-1040.
  .get("/bulk", async (c) => {
    const db = getDrizzleDb();
    const { rows, total } = await bulkQuery({
      query: db
        .select(joinedSelect)
        .from(equityPositions)
        .leftJoin(holderEntity, eq(equityPositions.holderEntityId, holderEntity.stableId))
        .leftJoin(companyEntity, eq(equityPositions.companyEntityId, companyEntity.stableId))
        .orderBy(desc(equityPositions.syncedAt), equityPositions.id),
      formatRow,
      routeName: "equity-positions/bulk",
    });
    return c.json({ equityPositions: rows, total });
  })

  // ---- GET /by-entity/:entityId (positions in a company) ----
  .get("/by-entity/:entityId", resolveEntityId(), zv("query", ByEntityQuery), async (c) => {
    const resolvedId = c.get("resolvedEntityId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const where = eq(equityPositions.companyId, resolvedId);

    const { rows, total } = await paginatedQuery({
      query: db
        .select(joinedSelect)
        .from(equityPositions)
        .leftJoin(holderEntity, eq(equityPositions.holderEntityId, holderEntity.stableId))
        .leftJoin(companyEntity, eq(equityPositions.companyEntityId, companyEntity.stableId))
        .where(where)
        .orderBy(desc(equityPositions.syncedAt), equityPositions.id)
        .limit(limit)
        .offset(offset),
      countQuery: db.select({ count: count() }).from(equityPositions).where(where),
      formatRow,
    });

    return c.json({
      entityId: resolvedId,
      equityPositions: rows,
      total,
      limit,
      offset,
    });
  })

  // ---- GET /by-holder/:holderId ----
  .get("/by-holder/:holderId", zv("query", ByEntityQuery), async (c) => {
    const holderId = c.req.param("holderId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const where = eq(equityPositions.holderId, holderId);

    const { rows, total } = await paginatedQuery({
      query: db
        .select(joinedSelect)
        .from(equityPositions)
        .leftJoin(holderEntity, eq(equityPositions.holderEntityId, holderEntity.stableId))
        .leftJoin(companyEntity, eq(equityPositions.companyEntityId, companyEntity.stableId))
        .where(where)
        .orderBy(desc(equityPositions.syncedAt), equityPositions.id)
        .limit(limit)
        .offset(offset),
      countQuery: db.select({ count: count() }).from(equityPositions).where(where),
      formatRow,
    });

    return c.json({
      holderId,
      equityPositions: rows,
      total,
      limit,
      offset,
    });
  })

  // ---- POST /sync — uses sync-factory ----
  .post(
    "/sync",
    createSyncHandler({
      name: "equity-positions",
      table: equityPositions,
      batchSchema: SyncEquityPositionsBatchSchema,
      entityRefFields: (items) => [
        { fieldName: "companyId", ids: items.map((i) => i.companyId) },
        { fieldName: "holderId", ids: items.map((i) => i.holderId) },
      ],
      toRow: (item, now) => {
        const stakeRange = parseRange(item.stake);
        return {
          id: item.id,
          companyId: item.companyId,
          holderId: item.holderId,
          stake: item.stake ?? null,
          stakeLow: stakeRange.low,
          stakeHigh: stakeRange.high,
          source: item.source ?? null,
          notes: item.notes ?? null,
          asOf: item.asOf ?? null,
          validEnd: item.validEnd ?? null,
          syncedAt: now,
          updatedAt: now,
        };
      },
      auditRecordType: "equity_positions",
      fkResolve: {
        tableName: "equity_positions",
        fields: [
          { rawIdColumn: "company_id", entityIdColumn: "company_entity_id", displayNameColumn: "company_display_name", entityTypeFilter: "organization" },
          { rawIdColumn: "holder_id", entityIdColumn: "holder_entity_id", displayNameColumn: "holder_display_name" },
        ],
      },
      toThing: (item) => ({
        id: item.id,
        thingType: "equity-position" as const,
        parentThingId: item.companyId,
        sourceTable: "equity_positions",
        sourceId: item.id,
        sourceUrl: item.source ?? null,
      }),
    }),
  )

  .post("/delete-batch", deleteBatchHandler(equityPositions, "equity_positions"));

// ---- Exports ----

export const equityPositionsRoute = equityPositionsApp;
export type EquityPositionsRoute = typeof equityPositionsApp;
