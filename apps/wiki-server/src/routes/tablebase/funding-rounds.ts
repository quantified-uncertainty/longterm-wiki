import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { eq, count, sql, desc, inArray, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDrizzleDb, getDb } from "../../db.js";
import { logger } from "../../logger.js";
import { fundingRounds, entities } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
  parseRange,
  noDuplicateIds,
  clampedLimit,
} from "../shared/utils.js";
import { upsertThingsInTx, resolveEntityTitles } from "../shared/thing-sync.js";
import { resolveEntityFKs } from "../shared/resolve-entity-fks.js";
import { validateEntityRefs } from "../shared/validate-entity-refs.js";
import { resolveEntityId, type ResolvedEntityVars } from "../shared/resolve-entity-middleware.js";
import { formatEntityRef } from "../shared/entity-ref.js";
import { InlineSourcingSchema } from "./sourcing-schema.js";
import { writeInlineVerdicts, logSourceCheckCoverage } from "./write-inline-verdicts.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { validateClaimRefs, linkClaimsToRecords } from "../shared/validate-claims.js";
import { createSyncHandler } from "./sync-factory.js";
import { useFactoryFor } from "./sync-factory-flag.js";

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

  // ---- POST /sync ----
  //
  // Phase 2 migration (issue #4090, discussion #4088): both factory and
  // legacy handlers coexist behind USE_SYNC_FACTORY_ROUTES feature flag.
  // After 7 days of clean metrics with the factory enabled (default), a
  // follow-up PR will remove `legacySyncHandler` and the conditional.
  //
  // Rollback: `USE_SYNC_FACTORY_ROUTES=!funding-rounds` falls back to legacy.
  .post("/sync", async (c) => {
    if (useFactoryFor("funding-rounds")) {
      return factorySyncHandler(c);
    }
    return legacySyncHandler(c);
  })

  .post("/delete-batch", deleteBatchHandler(fundingRounds, "funding_rounds"));

// ---- Factory implementation (Phase 2 migration) ----
//
// Escape hatch: `conflictSet` — funding_rounds uses COALESCE preservation on
// the entity FK columns (companyEntityId, leadInvestorEntityId, and their
// display names) so that updates don't clobber previously-resolved values
// with nulls. The legacy handler also did a pre-insert lookup to populate
// these columns directly, but `fkResolve` runs in the same transaction as a
// post-upsert backfill and achieves the same end state.
const factorySyncHandler = createSyncHandler({
  name: "funding-rounds",
  table: fundingRounds,
  batchSchema: SyncFundingRoundsBatchSchema,
  naturalKey: (item) => `${item.companyId}::${item.name}`,
  naturalKeyError:
    "Duplicate (companyId, name) in batch — each funding round must have a unique name within its company",
  entityRefFields: (items) => [
    { fieldName: "companyId", ids: items.map((i) => i.companyId) },
  ],
  claimSupport: {
    recordType: "funding-rounds",
    getClaimIds: (item) => item.claimIds ?? [],
  },
  toRow: (item) => {
    const raisedRange = parseRange(item.raised);
    const valuationRange = parseRange(item.valuation);
    return {
      id: item.id,
      companyId: item.companyId,
      companyEntityId: null,
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
      leadInvestorEntityId: null,
      leadInvestorDisplayName: item.leadInvestorDisplayName ?? null,
      source: item.source ?? null,
      notes: item.notes ?? null,
    };
  },
  conflictSet: {
    companyId: sql`excluded.company_id`,
    companyEntityId: sql`COALESCE(excluded.company_entity_id, ${fundingRounds.companyEntityId})`,
    companyDisplayName: sql`COALESCE(excluded.company_display_name, ${fundingRounds.companyDisplayName})`,
    name: sql`excluded.name`,
    date: sql`excluded.date`,
    raised: sql`excluded.raised`,
    raisedLow: sql`excluded.raised_low`,
    raisedHigh: sql`excluded.raised_high`,
    valuation: sql`excluded.valuation`,
    valuationLow: sql`excluded.valuation_low`,
    valuationHigh: sql`excluded.valuation_high`,
    instrument: sql`excluded.instrument`,
    leadInvestor: sql`excluded.lead_investor`,
    leadInvestorEntityId: sql`COALESCE(excluded.lead_investor_entity_id, ${fundingRounds.leadInvestorEntityId})`,
    leadInvestorDisplayName: sql`COALESCE(excluded.lead_investor_display_name, ${fundingRounds.leadInvestorDisplayName})`,
    source: sql`excluded.source`,
    notes: sql`excluded.notes`,
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
  thingsTitleIds: (items) => [...new Set(items.map((fr) => fr.companyId))],
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
  toVerdict: (item) => ({
    recordType: "funding-round",
    recordId: item.id,
    entityId: item.companyId,
    sourceUrl: item.source ?? null,
    sourcing: item.sourcing ?? null,
  }),
});

// ---- Legacy sync handler (kept for 7-day soak window after Phase 2 migration) ----

async function legacySyncHandler(c: Context) {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = SyncFundingRoundsBatchSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { items } = parsed.data;
  const db = getDrizzleDb();

  // Check for natural key collisions within the batch itself.
  // Natural key: (companyId, name)
  const batchKeys = new Set<string>();
  for (const item of items) {
    const key = `${item.companyId}::${item.name}`;
    if (batchKeys.has(key)) {
      return validationError(
        c,
        `Duplicate (companyId, name) in batch: ` +
        `companyId=${item.companyId}, name="${item.name}". ` +
        `Each funding round must have a unique name within its company.`
      );
    }
    batchKeys.add(key);
  }

  // Validate entity FK references before inserting
  const refError = await validateEntityRefs(c, db, [
    { fieldName: "companyId", ids: items.map((i) => i.companyId) },
  ]);
  if (refError) return refError;

  // Validate claim references
  const allClaimIds = items.flatMap((i) => i.claimIds ?? []);
  if (allClaimIds.length > 0) {
    const rawDb = getDb();
    const claimError = await validateClaimRefs(rawDb, allClaimIds);
    if (claimError) return validationError(c, claimError);
  }

  // Resolve companyId and leadInvestor values (slugs or stableIds) to proper stableIds
  // for the FK columns. This ensures companyEntityId and leadInvestorEntityId are populated
  // so the JOINs on GET /all work correctly.
  const uniqueCompanyIds = [...new Set(items.map((i) => i.companyId).filter(Boolean))];
  const uniqueLeadInvestorIds = [...new Set(
    items.map((i) => i.leadInvestor).filter((id): id is string => id != null && id !== "")
  )];
  const allUniqueIds = [...new Set([...uniqueCompanyIds, ...uniqueLeadInvestorIds])];
  const entityRows = allUniqueIds.length > 0
    ? await db
        .select({ id: entities.id, stableId: entities.stableId })
        .from(entities)
        .where(or(inArray(entities.id, allUniqueIds), inArray(entities.stableId, allUniqueIds)))
    : [];

  const entityStableIdMap = new Map<string, string>();
  for (const row of entityRows) {
    if (row.stableId) {
      entityStableIdMap.set(row.id, row.stableId);
      entityStableIdMap.set(row.stableId, row.stableId);
    }
  }

  let upserted = 0;
  let verdictsResult = { written: 0 };

  await db.transaction(async (tx) => {
    const allVals = items.map((item) => {
      const raisedRange = parseRange(item.raised);
      const valuationRange = parseRange(item.valuation);
      // Strip "new:" prefix from leadInvestor raw ID for entity resolution
      const rawLI = item.leadInvestor?.startsWith("new:") ? item.leadInvestor.slice(4).trim() : item.leadInvestor;
      return {
        id: item.id,
        companyId: item.companyId,
        companyEntityId: entityStableIdMap.get(item.companyId) ?? null,
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
        leadInvestorEntityId: rawLI ? (entityStableIdMap.get(rawLI) ?? null) : null,
        leadInvestorDisplayName: item.leadInvestorDisplayName ?? null,
        source: item.source ?? null,
        notes: item.notes ?? null,
      };
    });

    await tx
      .insert(fundingRounds)
      .values(allVals)
      .onConflictDoUpdate({
        target: fundingRounds.id,
        set: {
          companyId: sql`excluded.company_id`,
          companyEntityId: sql`COALESCE(excluded.company_entity_id, ${fundingRounds.companyEntityId})`,
          companyDisplayName: sql`COALESCE(excluded.company_display_name, ${fundingRounds.companyDisplayName})`,
          name: sql`excluded.name`,
          date: sql`excluded.date`,
          raised: sql`excluded.raised`,
          raisedLow: sql`excluded.raised_low`,
          raisedHigh: sql`excluded.raised_high`,
          valuation: sql`excluded.valuation`,
          valuationLow: sql`excluded.valuation_low`,
          valuationHigh: sql`excluded.valuation_high`,
          instrument: sql`excluded.instrument`,
          leadInvestor: sql`excluded.lead_investor`,
          leadInvestorEntityId: sql`COALESCE(excluded.lead_investor_entity_id, ${fundingRounds.leadInvestorEntityId})`,
          leadInvestorDisplayName: sql`COALESCE(excluded.lead_investor_display_name, ${fundingRounds.leadInvestorDisplayName})`,
          source: sql`excluded.source`,
          notes: sql`excluded.notes`,
          syncedAt: sql`now()`,
          updatedAt: sql`now()`,
        },
      });

    // Post-sync: resolve entity FKs as safety net (pre-insert JS resolution above
    // may miss entities added after the initial query)
    await resolveEntityFKs(tx, {
      tableName: "funding_rounds",
      fields: [
        { rawIdColumn: "company_id", entityIdColumn: "company_entity_id", displayNameColumn: "company_display_name", entityTypeFilter: "organization" },
        { rawIdColumn: "lead_investor", entityIdColumn: "lead_investor_entity_id", displayNameColumn: "lead_investor_display_name" },
      ],
      scopeIds: items.map((i) => i.id),
    });

    // Resolve company slugs to human-readable titles for search
    const companySlugs = [...new Set(items.map((fr) => fr.companyId))];
    const titleMap = await resolveEntityTitles(tx, companySlugs);

    // Dual-write to things table
    await upsertThingsInTx(
      tx,
      items.map((fr) => ({
        id: fr.id,
        thingType: "funding-round" as const,
        title: fr.name + (fr.date ? ` (${fr.date})` : ""),
        sourceTable: "funding_rounds",
        sourceId: fr.id,
        sourceUrl: fr.source,
        parentTitle: titleMap.get(fr.companyId) ?? fr.companyDisplayName ?? fr.companyId,
        description: [
          fr.raised != null ? `raised $${Number(fr.raised).toLocaleString()}` : null,
          fr.instrument,
          fr.leadInvestor ? `led by ${fr.leadInvestorDisplayName ?? fr.leadInvestor}` : null,
        ].filter(Boolean).join(", ") || null,
      }))
    );

    // Write inline source-check verdicts atomically within the same transaction
    verdictsResult = await writeInlineVerdicts(
      tx,
      items.map((item) => ({
        recordType: "funding-round",
        recordId: item.id,
        entityId: item.companyId,
        sourceUrl: item.source ?? null,
        sourcing: item.sourcing ?? null,
      }))
    );

    upserted = allVals.length;
  });

  logSourceCheckCoverage("funding-rounds/sync", items.length, verdictsResult.written);

  // Link verified claims to records (best-effort — records already committed)
  let claimsLinked = 0;
  let claimLinkingError: string | null = null;
  if (allClaimIds.length > 0) {
    try {
      const rawDb = getDb();
      const linkResult = await linkClaimsToRecords(rawDb, items.map((item) => ({
        recordId: item.id,
        recordType: "funding-rounds",
        claimIds: item.claimIds,
      })));
      claimsLinked = linkResult.linked;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      claimLinkingError = msg;
      logger.warn({ error: msg }, "claim linking failed (records already committed)");
    }
  }

  return c.json({ upserted, verdictsWritten: verdictsResult.written, claimsLinked, ...(claimLinkingError && { claimLinkingError }) });
}

// ---- Exports ----

export const fundingRoundsRoute = fundingRoundsApp;
export type FundingRoundsRoute = typeof fundingRoundsApp;
