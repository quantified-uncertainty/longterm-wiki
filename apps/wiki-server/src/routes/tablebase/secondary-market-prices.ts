import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, desc, asc, sql, gte, lte } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDrizzleDb } from "../../db.js";
import { secondaryMarketPrices, entities } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
  clampedLimit,
} from "../shared/utils.js";
import { resolveEntityId, type ResolvedEntityVars } from "../shared/resolve-entity-middleware.js";
import { formatEntityRef } from "../shared/entity-ref.js";
import { InlineSourcingSchema } from "./sourcing-schema.js";
import { writeInlineVerdicts, logSourceCheckCoverage } from "./write-inline-verdicts.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 500;

const VALID_PLATFORMS = [
  "ventuals",
  "forge",
  "hiive",
  "upmarket",
  "premier-alternatives",
  "notice",
] as const;

const VALID_PRICE_TYPES = [
  "mark",
  "oracle",
  "last_trade",
  "indicative",
  "bid",
  "ask",
  "mid",
] as const;

// ---- Query schemas ----

const AllQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 200),
  offset: z.coerce.number().int().min(0).default(0),
  platform: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

const ByEntityQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 200),
  offset: z.coerce.number().int().min(0).default(0),
  platform: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

const TimeseriesQuery = z.object({
  platform: z.string().optional(),
  priceType: z.string().optional(),
  limit: clampedLimit(MAX_PAGE_SIZE, 500),
});

// ---- Sync schema ----

const SyncSecondaryMarketPriceItemSchema = z.object({
  id: z.string().length(10),
  companyId: z.string().min(1).max(200),
  platform: z.enum(VALID_PLATFORMS),
  date: z.string().min(4).max(20),
  pricePerShare: z.number().nullable().optional(),
  impliedValuation: z.number().nullable().optional(),
  impliedValuationLow: z.number().nullable().optional(),
  impliedValuationHigh: z.number().nullable().optional(),
  volume: z.number().nullable().optional(),
  openInterest: z.number().nullable().optional(),
  bidPrice: z.number().nullable().optional(),
  askPrice: z.number().nullable().optional(),
  spreadPercent: z.number().nullable().optional(),
  priceType: z.enum(VALID_PRICE_TYPES).default("last_trade"),
  source: z.string().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  sourcing: InlineSourcingSchema.optional(),
});

const SyncBatchSchema = z.object({
  items: z.array(SyncSecondaryMarketPriceItemSchema).min(1).max(500),
});

// ---- Helpers ----

const companyEntity = alias(entities, "company_entity");

const joinedSelect = {
  price: secondaryMarketPrices,
  companyTitle: companyEntity.title,
  companySlug: companyEntity.id,
};

interface JoinedRow {
  price: typeof secondaryMarketPrices.$inferSelect;
  companyTitle: string | null;
  companySlug: string | null;
}

function formatRow(r: JoinedRow) {
  const p = r.price;
  const companyRef = formatEntityRef(
    p.companyEntityId,
    r.companySlug,
    r.companyTitle,
    p.companyDisplayName,
    p.companyId
  );
  return {
    id: p.id,
    companyId: p.companyId,
    platform: p.platform,
    date: p.date,
    pricePerShare: p.pricePerShare != null ? Number(p.pricePerShare) : null,
    impliedValuation: p.impliedValuation != null ? Number(p.impliedValuation) : null,
    impliedValuationLow: p.impliedValuationLow != null ? Number(p.impliedValuationLow) : null,
    impliedValuationHigh: p.impliedValuationHigh != null ? Number(p.impliedValuationHigh) : null,
    volume: p.volume != null ? Number(p.volume) : null,
    openInterest: p.openInterest != null ? Number(p.openInterest) : null,
    bidPrice: p.bidPrice != null ? Number(p.bidPrice) : null,
    askPrice: p.askPrice != null ? Number(p.askPrice) : null,
    spreadPercent: p.spreadPercent != null ? Number(p.spreadPercent) : null,
    priceType: p.priceType,
    source: p.source,
    notes: p.notes,
    company: companyRef,
    // Legacy flat fields
    companyEntityId: p.companyEntityId,
    companyDisplayName: p.companyDisplayName,
    companyResolvedName: companyRef.name,
    syncedAt: p.syncedAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function toNum(v: number | null | undefined): string | null {
  return v != null ? String(v) : null;
}

// ---- Route definition (method-chained for Hono RPC type inference) ----

const secondaryMarketPricesApp = new Hono<{ Variables: ResolvedEntityVars }>()

  // ---- GET /stats ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const [statsRow] = await db
      .select({
        total: count(),
        uniqueCompanies: sql<number>`count(distinct ${secondaryMarketPrices.companyId})`,
        uniquePlatforms: sql<number>`count(distinct ${secondaryMarketPrices.platform})`,
        latestDate: sql<string>`max(${secondaryMarketPrices.date})`,
        earliestDate: sql<string>`min(${secondaryMarketPrices.date})`,
      })
      .from(secondaryMarketPrices);

    return c.json({
      total: statsRow.total,
      uniqueCompanies: Number(statsRow.uniqueCompanies),
      uniquePlatforms: Number(statsRow.uniquePlatforms),
      latestDate: statsRow.latestDate,
      earliestDate: statsRow.earliestDate,
    });
  })

  // ---- GET /all ----
  .get("/all", zv("query", AllQuery), async (c) => {
    const { limit, offset, platform, dateFrom, dateTo } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [];
    if (platform) conditions.push(eq(secondaryMarketPrices.platform, platform));
    if (dateFrom) conditions.push(gte(secondaryMarketPrices.date, dateFrom));
    if (dateTo) conditions.push(lte(secondaryMarketPrices.date, dateTo));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select(joinedSelect)
      .from(secondaryMarketPrices)
      .leftJoin(companyEntity, eq(secondaryMarketPrices.companyEntityId, companyEntity.stableId))
      .where(whereClause)
      .orderBy(desc(secondaryMarketPrices.date), secondaryMarketPrices.platform)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(secondaryMarketPrices)
      .where(whereClause);
    const total = countResult[0].count;

    return c.json({
      prices: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /by-entity/:entityId ----
  .get("/by-entity/:entityId", resolveEntityId(), zv("query", ByEntityQuery), async (c) => {
    const resolvedId = c.get("resolvedEntityId");
    const { limit, offset, platform, dateFrom, dateTo } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [eq(secondaryMarketPrices.companyEntityId, resolvedId)];
    if (platform) conditions.push(eq(secondaryMarketPrices.platform, platform));
    if (dateFrom) conditions.push(gte(secondaryMarketPrices.date, dateFrom));
    if (dateTo) conditions.push(lte(secondaryMarketPrices.date, dateTo));

    const whereClause = and(...conditions);

    const rows = await db
      .select(joinedSelect)
      .from(secondaryMarketPrices)
      .leftJoin(companyEntity, eq(secondaryMarketPrices.companyEntityId, companyEntity.stableId))
      .where(whereClause)
      .orderBy(desc(secondaryMarketPrices.date), secondaryMarketPrices.platform)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(secondaryMarketPrices)
      .where(whereClause);
    const total = countResult[0].count;

    return c.json({
      entityId: resolvedId,
      prices: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /latest/:entityId ----
  .get("/latest/:entityId", resolveEntityId(), async (c) => {
    const resolvedId = c.get("resolvedEntityId");
    const db = getDrizzleDb();

    // Get the most recent price from each platform for this company
    const rows = await db
      .select(joinedSelect)
      .from(secondaryMarketPrices)
      .leftJoin(companyEntity, eq(secondaryMarketPrices.companyEntityId, companyEntity.stableId))
      .where(eq(secondaryMarketPrices.companyEntityId, resolvedId))
      .orderBy(desc(secondaryMarketPrices.date), secondaryMarketPrices.platform)
      .limit(50);

    // Deduplicate: keep only the latest per platform+priceType
    const seen = new Set<string>();
    const latest = rows.filter((r) => {
      const key = `${r.price.platform}:${r.price.priceType}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Compute summary stats
    const valuations = latest
      .map((r) => r.price.impliedValuation)
      .filter((v): v is string => v != null)
      .map(Number);
    const sorted = valuations.length > 0 ? [...valuations].sort((a, b) => a - b) : [];
    const median = sorted.length > 0
      ? sorted.length % 2 === 1
        ? sorted[Math.floor(sorted.length / 2)]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : null;
    const min = valuations.length > 0 ? Math.min(...valuations) : null;
    const max = valuations.length > 0 ? Math.max(...valuations) : null;

    return c.json({
      entityId: resolvedId,
      prices: latest.map(formatRow),
      summary: {
        platformCount: latest.length,
        medianValuation: median,
        minValuation: min,
        maxValuation: max,
        dispersionPercent: median != null && min != null && max != null
          ? Math.round(((max - min) / median) * 100)
          : null,
      },
    });
  })

  // ---- GET /timeseries/:entityId ----
  .get("/timeseries/:entityId", resolveEntityId(), zv("query", TimeseriesQuery), async (c) => {
    const resolvedId = c.get("resolvedEntityId");
    const { platform, priceType, limit } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [eq(secondaryMarketPrices.companyEntityId, resolvedId)];
    if (platform) conditions.push(eq(secondaryMarketPrices.platform, platform));
    if (priceType) conditions.push(eq(secondaryMarketPrices.priceType, priceType));

    const rows = await db
      .select({
        date: secondaryMarketPrices.date,
        platform: secondaryMarketPrices.platform,
        priceType: secondaryMarketPrices.priceType,
        pricePerShare: secondaryMarketPrices.pricePerShare,
        impliedValuation: secondaryMarketPrices.impliedValuation,
        volume: secondaryMarketPrices.volume,
      })
      .from(secondaryMarketPrices)
      .where(and(...conditions))
      .orderBy(asc(secondaryMarketPrices.date), secondaryMarketPrices.platform)
      .limit(limit);

    return c.json({
      entityId: resolvedId,
      points: rows.map((r) => ({
        date: r.date,
        platform: r.platform,
        priceType: r.priceType,
        pricePerShare: r.pricePerShare != null ? Number(r.pricePerShare) : null,
        impliedValuation: r.impliedValuation != null ? Number(r.impliedValuation) : null,
        volume: r.volume != null ? Number(r.volume) : null,
      })),
      total: rows.length,
    });
  })

  // ---- POST /sync ----
  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;
    const db = getDrizzleDb();

    let upserted = 0;
    let verdictsResult = { written: 0 };

    await db.transaction(async (tx) => {
      const allVals = items.map((item) => ({
        id: item.id,
        companyId: item.companyId,
        platform: item.platform,
        date: item.date,
        pricePerShare: toNum(item.pricePerShare),
        impliedValuation: toNum(item.impliedValuation),
        impliedValuationLow: toNum(item.impliedValuationLow),
        impliedValuationHigh: toNum(item.impliedValuationHigh),
        volume: toNum(item.volume),
        openInterest: toNum(item.openInterest),
        bidPrice: toNum(item.bidPrice),
        askPrice: toNum(item.askPrice),
        spreadPercent: toNum(item.spreadPercent),
        priceType: item.priceType,
        source: item.source ?? null,
        notes: item.notes ?? null,
      }));

      await tx
        .insert(secondaryMarketPrices)
        .values(allVals)
        .onConflictDoUpdate({
          target: [
            secondaryMarketPrices.companyId,
            secondaryMarketPrices.platform,
            secondaryMarketPrices.date,
            secondaryMarketPrices.priceType,
          ],
          set: {
            pricePerShare: sql`excluded.price_per_share`,
            impliedValuation: sql`excluded.implied_valuation`,
            impliedValuationLow: sql`excluded.implied_valuation_low`,
            impliedValuationHigh: sql`excluded.implied_valuation_high`,
            volume: sql`excluded.volume`,
            openInterest: sql`excluded.open_interest`,
            bidPrice: sql`excluded.bid_price`,
            askPrice: sql`excluded.ask_price`,
            spreadPercent: sql`excluded.spread_percent`,
            source: sql`excluded.source`,
            notes: sql`excluded.notes`,
            syncedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        });

      // Write inline source-check verdicts atomically within the same transaction
      verdictsResult = await writeInlineVerdicts(
        tx,
        items.map((item) => ({
          recordType: "secondary-market-price",
          recordId: item.id,
          entityId: item.companyId,
          sourceUrl: item.source ?? null,
          sourcing: item.sourcing ?? null,
        }))
      );

      upserted = allVals.length;
    });

    logSourceCheckCoverage("secondary-market-prices/sync", items.length, verdictsResult.written);

    return c.json({ upserted, verdictsWritten: verdictsResult.written });
  })

  .post("/delete-batch", deleteBatchHandler(secondaryMarketPrices, "secondary_market_prices"));

// ---- Exports ----

export const secondaryMarketPricesRoute = secondaryMarketPricesApp;
export type SecondaryMarketPricesRoute = typeof secondaryMarketPricesApp;
