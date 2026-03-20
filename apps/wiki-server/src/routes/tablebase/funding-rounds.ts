import { Hono } from "hono";
import { z } from "zod";
import { eq, count, sql, desc } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDrizzleDb } from "../../db.js";
import { fundingRounds, entities } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
  parseRange,
} from "../shared/utils.js";
import { upsertThingsInTx, resolveEntityTitles } from "../shared/thing-sync.js";
import { validateEntityRefs } from "../shared/validate-entity-refs.js";
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

const SyncFundingRoundItemSchema = z.object({
  id: z.string().length(10),
  companyId: z.string().min(1).max(200),
  name: z.string().min(1).max(500),
  date: z.string().max(20).nullable().optional(),
  raised: z.number().nullable().optional(),
  valuation: z.number().nullable().optional(),
  instrument: z.string().max(100).nullable().optional(),
  leadInvestor: z.string().max(500).nullable().optional(),
  source: z.string().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const SyncFundingRoundsBatchSchema = z.object({
  items: z.array(SyncFundingRoundItemSchema).min(1).max(500),
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
  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncFundingRoundsBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;
    const db = getDrizzleDb();

    // Validate entity FK references before inserting
    const refError = await validateEntityRefs(c, db, [
      { fieldName: "companyId", ids: items.map((i) => i.companyId) },
    ]);
    if (refError) return refError;

    let upserted = 0;

    await db.transaction(async (tx) => {
      const allVals = items.map((item) => {
        const raisedRange = parseRange(item.raised);
        const valuationRange = parseRange(item.valuation);
        return {
          id: item.id,
          companyId: item.companyId,
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
            source: sql`excluded.source`,
            notes: sql`excluded.notes`,
            syncedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
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
          parentTitle: titleMap.get(fr.companyId) ?? fr.companyId,
          description: [
            fr.raised != null ? `raised $${Number(fr.raised).toLocaleString()}` : null,
            fr.instrument,
            fr.leadInvestor ? `led by ${fr.leadInvestor}` : null,
          ].filter(Boolean).join(", ") || null,
        }))
      );

      upserted = allVals.length;
    });

    return c.json({ upserted });
  });

// ---- Exports ----

export const fundingRoundsRoute = fundingRoundsApp;
export type FundingRoundsRoute = typeof fundingRoundsApp;
