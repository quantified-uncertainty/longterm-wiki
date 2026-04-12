import { Hono } from "hono";
import { z } from "zod";
import { eq, count, sql, desc } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDrizzleDb } from "../../db.js";
import { fundingRounds, entities } from "../../schema.js";
import {
  zv,
  parseRange,
  noDuplicateIds,
  clampedLimit,
} from "../shared/utils.js";
import { resolveEntityId, type ResolvedEntityVars } from "../shared/resolve-entity-middleware.js";
import { formatEntityRef } from "../shared/entity-ref.js";
import { InlineSourcingSchema } from "./sourcing-schema.js";
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

const SyncFundingRoundItemSchema = z.object({
  id: z.string().length(10),
  companyId: z.string().min(1).max(200),
  companyDisplayName: z.string().max(500).nullable().optional(),
  name: z.string().min(1).max(500),
  date: z.string().max(20).nullable().optional(),
  raised: z.number().nullable().optional(),
  valuation: z.number().nullable().optional(),
  instrument: z.string().max(100).nullable().optional(),
  leadInvestor: z.string().max(500).nullable().optional(),
  leadInvestorDisplayName: z.string().max(500).nullable().optional(),
  source: z.string().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  sourcing: InlineSourcingSchema.optional(),
  claimIds: z.array(z.number().int().positive()).optional(),
});

const SyncFundingRoundsBatchSchema = z.object({
  items: z
    .array(SyncFundingRoundItemSchema)
    .min(1)
    .max(500)
    .refine(noDuplicateIds, { message: "Duplicate id values in items array" }),
});

// ---- Helpers ----

const leadInvestorEntity = alias(entities, "lead_investor_entity");
const companyEntity = alias(entities, "company_entity");

/** Selection shape for funding_rounds + joined entity titles + slugs. */
const joinedSelect = {
  fundingRound: fundingRounds,
  leadInvestorTitle: leadInvestorEntity.title,
  leadInvestorSlug: leadInvestorEntity.id,
  companyTitle: companyEntity.title,
  companySlug: companyEntity.id,
};

interface JoinedRow {
  fundingRound: typeof fundingRounds.$inferSelect;
  leadInvestorTitle: string | null;
  leadInvestorSlug: string | null;
  companyTitle: string | null;
  companySlug: string | null;
}

function formatRow(r: JoinedRow) {
  const fr = r.fundingRound;
  // Strip "new:" prefix from leadInvestor raw ID before passing to formatEntityRef
  const rawLI = fr.leadInvestor?.startsWith("new:") ? fr.leadInvestor.slice(4).trim() : fr.leadInvestor;
  return {
    id: fr.id,
    companyId: fr.companyId,
    name: fr.name,
    date: fr.date,
    raised: fr.raised != null ? Number(fr.raised) : null,
    raisedLow: fr.raisedLow != null ? Number(fr.raisedLow) : null,
    raisedHigh: fr.raisedHigh != null ? Number(fr.raisedHigh) : null,
    valuation: fr.valuation != null ? Number(fr.valuation) : null,
    valuationLow: fr.valuationLow != null ? Number(fr.valuationLow) : null,
    valuationHigh: fr.valuationHigh != null ? Number(fr.valuationHigh) : null,
    instrument: fr.instrument,
    leadInvestorRaw: fr.leadInvestor,
    // Structured entity refs
    leadInvestorRef: formatEntityRef(fr.leadInvestorEntityId, r.leadInvestorSlug, r.leadInvestorTitle, fr.leadInvestorDisplayName, rawLI ?? null),
    companyRef: formatEntityRef(fr.companyEntityId, r.companySlug, r.companyTitle, fr.companyDisplayName, fr.companyId),
    // Legacy flat fields (for backward compat)
    leadInvestor: fr.leadInvestor,
    leadInvestorEntityId: fr.leadInvestorEntityId,
    leadInvestorDisplayName: fr.leadInvestorDisplayName,
    leadInvestorResolvedName: (r.leadInvestorTitle ?? fr.leadInvestorDisplayName ?? rawLI) as string | null,
    companyEntityId: fr.companyEntityId,
    companyDisplayName: fr.companyDisplayName,
    companyResolvedName: (r.companyTitle ?? fr.companyDisplayName ?? fr.companyId) as string | null,
    source: fr.source,
    notes: fr.notes,
    syncedAt: fr.syncedAt,
    createdAt: fr.createdAt,
    updatedAt: fr.updatedAt,
  };
}

// ---- Route definition (method-chained for Hono RPC type inference) ----

const fundingRoundsApp = new Hono<{ Variables: ResolvedEntityVars }>()

  // ---- GET /stats ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const [statsRow] = await db
      .select({
        total: count(),
        totalRaised: sql<number>`coalesce(sum(${fundingRounds.raised}), 0)`,
        uniqueCompanies: sql<number>`count(distinct ${fundingRounds.companyId})`,
      })
      .from(fundingRounds);

    return c.json({
      total: statsRow.total,
      totalRaised: Number(statsRow.totalRaised),
      uniqueCompanies: Number(statsRow.uniqueCompanies),
    });
  })

  // ---- GET /all ----
  .get("/all", zv("query", AllQuery), async (c) => {
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select(joinedSelect)
      .from(fundingRounds)
      .leftJoin(companyEntity, eq(fundingRounds.companyEntityId, companyEntity.stableId))
      .leftJoin(leadInvestorEntity, eq(fundingRounds.leadInvestorEntityId, leadInvestorEntity.stableId))
      .orderBy(desc(fundingRounds.syncedAt), fundingRounds.id)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(fundingRounds);
    const total = countResult[0].count;

    return c.json({
      fundingRounds: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /by-entity/:entityId ----
  .get("/by-entity/:entityId", resolveEntityId(), zv("query", ByEntityQuery), async (c) => {
    const resolvedId = c.get("resolvedEntityId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();
    const rows = await db
      .select(joinedSelect)
      .from(fundingRounds)
      .leftJoin(companyEntity, eq(fundingRounds.companyEntityId, companyEntity.stableId))
      .leftJoin(leadInvestorEntity, eq(fundingRounds.leadInvestorEntityId, leadInvestorEntity.stableId))
      .where(eq(fundingRounds.companyId, resolvedId))
      .orderBy(desc(fundingRounds.syncedAt), fundingRounds.id)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(fundingRounds)
      .where(eq(fundingRounds.companyId, resolvedId));
    const total = countResult[0].count;

    return c.json({
      entityId: resolvedId,
      fundingRounds: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- POST /sync — uses sync-factory ----
  .post(
    "/sync",
    createSyncHandler({
      name: "funding-rounds",
      table: fundingRounds,
      batchSchema: SyncFundingRoundsBatchSchema,
      enforceSourcing: true,
      naturalKey: (item) => `${item.companyId}::${item.name}`,
      naturalKeyError:
        "Duplicate (companyId, name) in batch",
      entityRefs: ["companyId"],
      toRow: (item, now) => {
        const raisedRange = parseRange(item.raised);
        const valuationRange = parseRange(item.valuation);
        return {
          id: item.id,
          companyId: item.companyId,
          companyEntityId: null, // populated by fkResolve post-upsert
          companyDisplayName: item.companyDisplayName ?? null,
          name: item.name,
          date: item.date ?? null,
          raised: item.raised != null ? String(item.raised) : null,
          raisedLow: raisedRange.low,
          raisedHigh: raisedRange.high,
          valuation: item.valuation != null ? String(item.valuation) : null,
          valuationLow: valuationRange.low,
          valuationHigh: valuationRange.high,
          instrument: item.instrument ?? null,
          leadInvestor: item.leadInvestor ?? null,
          leadInvestorEntityId: null, // populated by fkResolve post-upsert
          leadInvestorDisplayName: item.leadInvestorDisplayName ?? null,
          source: item.source ?? null,
          notes: item.notes ?? null,
          syncedAt: now,
          updatedAt: now,
        };
      },
      conflictSet: {
        companyId: sql.raw(`excluded.company_id`),
        companyEntityId: sql`COALESCE(excluded.company_entity_id, ${fundingRounds.companyEntityId})`,
        companyDisplayName: sql`COALESCE(excluded.company_display_name, ${fundingRounds.companyDisplayName})`,
        name: sql.raw(`excluded.name`),
        date: sql.raw(`excluded.date`),
        raised: sql.raw(`excluded.raised`),
        raisedLow: sql.raw(`excluded.raised_low`),
        raisedHigh: sql.raw(`excluded.raised_high`),
        valuation: sql.raw(`excluded.valuation`),
        valuationLow: sql.raw(`excluded.valuation_low`),
        valuationHigh: sql.raw(`excluded.valuation_high`),
        instrument: sql.raw(`excluded.instrument`),
        leadInvestor: sql.raw(`excluded.lead_investor`),
        leadInvestorEntityId: sql`COALESCE(excluded.lead_investor_entity_id, ${fundingRounds.leadInvestorEntityId})`,
        leadInvestorDisplayName: sql`COALESCE(excluded.lead_investor_display_name, ${fundingRounds.leadInvestorDisplayName})`,
        source: sql.raw(`excluded.source`),
        notes: sql.raw(`excluded.notes`),
        syncedAt: sql`now()`,
        updatedAt: sql`now()`,
      },
      fkResolve: {
        tableName: "funding_rounds",
        fields: [
          { rawIdColumn: "company_id", entityIdColumn: "company_entity_id", displayNameColumn: "company_display_name", entityTypeFilter: "organization" },
          { rawIdColumn: "lead_investor", entityIdColumn: "lead_investor_entity_id", displayNameColumn: "lead_investor_display_name" },
        ],
      },
      toThing: (item, titleMap) => ({
        id: item.id,
        thingType: "funding-round" as const,
        title: item.name + (item.date ? ` (${item.date})` : ""),
        sourceTable: "funding_rounds",
        sourceId: item.id,
        sourceUrl: item.source,
        parentTitle: titleMap.get(item.companyId) ?? item.companyDisplayName ?? item.companyId,
        description: [
          item.raised != null ? `raised $${Number(item.raised).toLocaleString()}` : null,
          item.instrument,
          item.leadInvestor ? `led by ${item.leadInvestorDisplayName ?? item.leadInvestor}` : null,
        ].filter(Boolean).join(", ") || null,
      }),
      thingsTitleIds: (items) => [...new Set(items.map((fr) => fr.companyId))],
      toVerdict: (item) => ({
        recordType: "funding-round",
        recordId: item.id,
        entityId: item.companyId,
        sourceUrl: item.source ?? null,
        sourcing: item.sourcing ?? null,
      }),
      claimSupport: {
        recordType: "funding-rounds",
        getClaimIds: (item) => item.claimIds ?? [],
      },
    }),
  )

  .post("/delete-batch", deleteBatchHandler(fundingRounds, "funding_rounds"));

// ---- Exports ----

export const fundingRoundsRoute = fundingRoundsApp;
export type FundingRoundsRoute = typeof fundingRoundsApp;
