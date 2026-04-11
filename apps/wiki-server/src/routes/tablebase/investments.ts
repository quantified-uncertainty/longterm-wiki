import { Hono } from "hono";
import { z } from "zod";
import { eq, count, sql, desc } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDrizzleDb } from "../../db.js";
import { investments, entities } from "../../schema.js";
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

const SyncInvestmentItemSchema = z.object({
  id: z.string().length(10),
  companyId: z.string().min(1).max(200),
  investorId: z.string().min(1).max(200),
  roundName: z.string().max(500).nullable().optional(),
  date: z.string().max(20).nullable().optional(),
  amount: z.number().nullable().optional(),
  stakeAcquired: z.string().max(200).nullable().optional(),
  instrument: z.string().max(100).nullable().optional(),
  role: z.string().max(50).nullable().optional(),
  conditions: z.string().max(2000).nullable().optional(),
  source: z.string().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  sourcing: InlineSourcingSchema.optional(),
  claimIds: z.array(z.number().int().positive()).optional(),
});

const SyncInvestmentsBatchSchema = z.object({
  items: z
    .array(SyncInvestmentItemSchema)
    .min(1)
    .max(500)
    .refine(noDuplicateIds, { message: "Duplicate id values in items array" }),
});

// ---- Helpers ----

const investorEntity = alias(entities, "investor_entity");
const companyEntity = alias(entities, "company_entity");

/** Selection shape for investments + joined entity titles + slugs. */
const joinedSelect = {
  investments: investments,
  investorTitle: investorEntity.title,
  investorSlug: investorEntity.id,
  companyTitle: companyEntity.title,
  companySlug: companyEntity.id,
};

interface JoinedRow {
  investments: typeof investments.$inferSelect;
  investorTitle: string | null;
  investorSlug: string | null;
  companyTitle: string | null;
  companySlug: string | null;
}

function formatRow(r: JoinedRow) {
  const inv = r.investments;
  const investorRef = formatEntityRef(inv.investorEntityId, r.investorSlug, r.investorTitle, inv.investorDisplayName, inv.investorId);
  const companyRef = formatEntityRef(inv.companyEntityId, r.companySlug, r.companyTitle, inv.companyDisplayName, inv.companyId);
  return {
    id: inv.id,
    companyId: inv.companyId,
    investorId: inv.investorId,
    roundName: inv.roundName,
    date: inv.date,
    amount: inv.amount != null ? Number(inv.amount) : null,
    amountLow: inv.amountLow != null ? Number(inv.amountLow) : null,
    amountHigh: inv.amountHigh != null ? Number(inv.amountHigh) : null,
    stakeAcquired: inv.stakeAcquired,
    stakeLow: inv.stakeLow != null ? Number(inv.stakeLow) : null,
    stakeHigh: inv.stakeHigh != null ? Number(inv.stakeHigh) : null,
    instrument: inv.instrument,
    role: inv.role,
    conditions: inv.conditions,
    source: inv.source,
    notes: inv.notes,
    // Structured entity refs
    investor: investorRef,
    company: companyRef,
    // Legacy flat fields (for backward compat)
    investorEntityId: inv.investorEntityId,
    investorDisplayName: inv.investorDisplayName,
    investorResolvedName: investorRef.name,
    companyEntityId: inv.companyEntityId,
    companyDisplayName: inv.companyDisplayName,
    companyResolvedName: companyRef.name,
    syncedAt: inv.syncedAt,
    createdAt: inv.createdAt,
    updatedAt: inv.updatedAt,
  };
}

// ---- Route definition (method-chained for Hono RPC type inference) ----

const investmentsApp = new Hono<{ Variables: ResolvedEntityVars }>()

  // ---- GET /stats ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const [statsRow] = await db
      .select({
        total: count(),
        totalAmount: sql<number>`coalesce(sum(${investments.amount}), 0)`,
        uniqueCompanies: sql<number>`count(distinct ${investments.companyId})`,
        uniqueInvestors: sql<number>`count(distinct ${investments.investorId})`,
      })
      .from(investments);

    return c.json({
      total: statsRow.total,
      totalAmount: Number(statsRow.totalAmount),
      uniqueCompanies: Number(statsRow.uniqueCompanies),
      uniqueInvestors: Number(statsRow.uniqueInvestors),
    });
  })

  // ---- GET /all ----
  .get("/all", zv("query", AllQuery), async (c) => {
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select(joinedSelect)
      .from(investments)
      .leftJoin(investorEntity, eq(investments.investorEntityId, investorEntity.stableId))
      .leftJoin(companyEntity, eq(investments.companyEntityId, companyEntity.stableId))
      .orderBy(desc(investments.syncedAt), investments.id)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(investments);
    const total = countResult[0].count;

    return c.json({
      investments: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /by-entity/:entityId (investments in a company) ----
  .get("/by-entity/:entityId", resolveEntityId(), zv("query", ByEntityQuery), async (c) => {
    const resolvedId = c.get("resolvedEntityId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();
    const rows = await db
      .select(joinedSelect)
      .from(investments)
      .leftJoin(investorEntity, eq(investments.investorEntityId, investorEntity.stableId))
      .leftJoin(companyEntity, eq(investments.companyEntityId, companyEntity.stableId))
      .where(eq(investments.companyId, resolvedId))
      .orderBy(desc(investments.syncedAt), investments.id)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(investments)
      .where(eq(investments.companyId, resolvedId));
    const total = countResult[0].count;

    return c.json({
      entityId: resolvedId,
      investments: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /by-investor/:investorId ----
  .get("/by-investor/:investorId", zv("query", ByEntityQuery), async (c) => {
    const investorId = c.req.param("investorId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select(joinedSelect)
      .from(investments)
      .leftJoin(investorEntity, eq(investments.investorEntityId, investorEntity.stableId))
      .leftJoin(companyEntity, eq(investments.companyEntityId, companyEntity.stableId))
      .where(eq(investments.investorId, investorId))
      .orderBy(desc(investments.syncedAt), investments.id)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(investments)
      .where(eq(investments.investorId, investorId));
    const total = countResult[0].count;

    return c.json({
      investorId,
      investments: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- POST /sync — uses sync-factory ----
  .post(
    "/sync",
    createSyncHandler({
      name: "investments",
      table: investments,
      batchSchema: SyncInvestmentsBatchSchema,
      naturalKey: (item) =>
        `${item.companyId}::${item.investorId}::${item.roundName ?? ""}`,
      naturalKeyError:
        "Duplicate (companyId, investorId, roundName) in batch",
      entityRefFields: (items) => [
        { fieldName: "companyId", ids: items.map((i) => i.companyId) },
        { fieldName: "investorId", ids: items.map((i) => i.investorId) },
      ],
      // Reject items with "Unknown" investor or company names.
      // These create low-quality rows that display poorly on the public page.
      preValidate: async (c, _db, items) => {
        const unknownItems = items.filter(
          (i) =>
            i.investorId.toLowerCase() === "unknown" ||
            i.companyId.toLowerCase() === "unknown"
        );
        if (unknownItems.length > 0) {
          const ids = unknownItems.map((i) => i.id).join(", ");
          return c.json(
            { error: `Investments with "Unknown" investor or company are not allowed. Affected IDs: ${ids}` },
            400,
          );
        }
        return null;
      },
      toRow: (item, now) => {
        const amountRange = parseRange(item.amount);
        const stakeRange = parseRange(item.stakeAcquired);
        return {
          id: item.id,
          companyId: item.companyId,
          investorId: item.investorId,
          roundName: item.roundName ?? null,
          date: item.date ?? null,
          amount: item.amount != null ? String(item.amount) : null,
          amountLow: amountRange.low,
          amountHigh: amountRange.high,
          stakeAcquired: item.stakeAcquired ?? null,
          stakeLow: stakeRange.low,
          stakeHigh: stakeRange.high,
          instrument: item.instrument ?? null,
          role: item.role ?? null,
          conditions: item.conditions ?? null,
          source: item.source ?? null,
          notes: item.notes ?? null,
          syncedAt: now,
          updatedAt: now,
        };
      },
      fkResolve: {
        tableName: "investments",
        fields: [
          { rawIdColumn: "company_id", entityIdColumn: "company_entity_id", displayNameColumn: "company_display_name", entityTypeFilter: "organization" },
          { rawIdColumn: "investor_id", entityIdColumn: "investor_entity_id", displayNameColumn: "investor_display_name" },
        ],
      },
      toThing: (item) => ({
        id: item.id,
        thingType: "investment" as const,
        title: `${item.investorId} → ${item.companyId}${item.roundName ? ` (${item.roundName})` : ""}`,
        sourceTable: "investments",
        sourceId: item.id,
        sourceUrl: item.source,
      }),
      toVerdict: (item) => ({
        recordType: "investment",
        recordId: item.id,
        entityId: item.companyId,
        sourceUrl: item.source ?? null,
        sourcing: item.sourcing ?? null,
      }),
      claimSupport: {
        recordType: "investments",
        getClaimIds: (item) => item.claimIds ?? [],
      },
    }),
  )

  .post("/delete-batch", deleteBatchHandler(investments, "investments"));

// ---- Exports ----

export const investmentsRoute = investmentsApp;
export type InvestmentsRoute = typeof investmentsApp;
