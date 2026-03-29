import { Hono } from "hono";
import { z } from "zod";
import { eq, count, desc, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDrizzleDb } from "../../db.js";
import { equityPositions, entities } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
  parseRange,
} from "../shared/utils.js";
import { upsertThingsInTx } from "../shared/thing-sync.js";
import { resolveEntityFKs } from "../shared/resolve-entity-fks.js";
import { resolveEntityId, type ResolvedEntityVars } from "../shared/resolve-entity-middleware.js";
import { formatEntityRef } from "../shared/entity-ref.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

// ---- Query schemas ----

const ByEntityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const AllQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(200),
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

    const rows = await db
      .select(joinedSelect)
      .from(equityPositions)
      .leftJoin(holderEntity, eq(equityPositions.holderEntityId, holderEntity.stableId))
      .leftJoin(companyEntity, eq(equityPositions.companyEntityId, companyEntity.stableId))
      .orderBy(desc(equityPositions.syncedAt), equityPositions.id)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(equityPositions);
    const total = countResult[0].count;

    return c.json({
      equityPositions: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /by-entity/:entityId (positions in a company) ----
  .get("/by-entity/:entityId", resolveEntityId(), zv("query", ByEntityQuery), async (c) => {
    const resolvedId = c.get("resolvedEntityId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();
    const rows = await db
      .select(joinedSelect)
      .from(equityPositions)
      .leftJoin(holderEntity, eq(equityPositions.holderEntityId, holderEntity.stableId))
      .leftJoin(companyEntity, eq(equityPositions.companyEntityId, companyEntity.stableId))
      .where(eq(equityPositions.companyId, resolvedId))
      .orderBy(desc(equityPositions.syncedAt), equityPositions.id)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(equityPositions)
      .where(eq(equityPositions.companyId, resolvedId));
    const total = countResult[0].count;

    return c.json({
      entityId: resolvedId,
      equityPositions: rows.map(formatRow),
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

    const rows = await db
      .select(joinedSelect)
      .from(equityPositions)
      .leftJoin(holderEntity, eq(equityPositions.holderEntityId, holderEntity.stableId))
      .leftJoin(companyEntity, eq(equityPositions.companyEntityId, companyEntity.stableId))
      .where(eq(equityPositions.holderId, holderId))
      .orderBy(desc(equityPositions.syncedAt), equityPositions.id)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(equityPositions)
      .where(eq(equityPositions.holderId, holderId));
    const total = countResult[0].count;

    return c.json({
      holderId,
      equityPositions: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- POST /sync ----
  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncEquityPositionsBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;
    const db = getDrizzleDb();

    let upserted = 0;

    await db.transaction(async (tx) => {
      const allVals = items.map((item) => {
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
        };
      });

      await tx
        .insert(equityPositions)
        .values(allVals)
        .onConflictDoUpdate({
          target: equityPositions.id,
          set: {
            companyId: sql`excluded.company_id`,
            holderId: sql`excluded.holder_id`,
            stake: sql`excluded.stake`,
            stakeLow: sql`excluded.stake_low`,
            stakeHigh: sql`excluded.stake_high`,
            source: sql`excluded.source`,
            notes: sql`excluded.notes`,
            asOf: sql`excluded.as_of`,
            validEnd: sql`excluded.valid_end`,
            syncedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        });

      // Post-sync: resolve entity FKs for newly synced rows
      await resolveEntityFKs(tx, {
        tableName: "equity_positions",
        fields: [
          { rawIdColumn: "company_id", entityIdColumn: "company_entity_id", displayNameColumn: "company_display_name", entityTypeFilter: "organization" },
          { rawIdColumn: "holder_id", entityIdColumn: "holder_entity_id", displayNameColumn: "holder_display_name" },
        ],
        scopeIds: items.map((i) => i.id),
      });

      // Dual-write to things table
      await upsertThingsInTx(
        tx,
        items.map((ep) => ({
          id: ep.id,
          thingType: "equity-position" as const,
          title: `${ep.holderId} stake in ${ep.companyId}`,
          sourceTable: "equity_positions",
          sourceId: ep.id,
          sourceUrl: ep.source,
        }))
      );

      upserted = allVals.length;
    });

    return c.json({ upserted });
  });

// ---- Exports ----

export const equityPositionsRoute = equityPositionsApp;
export type EquityPositionsRoute = typeof equityPositionsApp;
