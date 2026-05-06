import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, desc, sql, sum } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDrizzleDb } from "../../db.js";
import { campaignFinance, entities } from "../../schema.js";
import {
  zv,
  clampedLimit,
} from "../shared/utils.js";
import { formatEntityRef } from "../shared/entity-ref.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { createSyncHandler } from "./sync-factory.js";
import { paginatedQuery } from "../shared/paginated-query.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 500;

// ---- Query schemas ----

const ListQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 200),
  offset: z.coerce.number().int().min(0).default(0),
  cycle: z.coerce.number().int().optional(),
  state: z.string().max(5).optional(),
  officeType: z.string().max(30).optional(),
  party: z.string().max(20).optional(),
});

// ---- Sync schemas ----

const SyncItemSchema = z.object({
  id: z.string().length(10),
  politicianEntityId: z.string().min(1).max(40).nullable().optional(),
  politicianDisplayName: z.string().max(200).nullable().optional(),
  cycle: z.number().int().min(1990).max(2100),
  totalRaised: z.number().nullable().optional(),
  totalSpent: z.number().nullable().optional(),
  cashOnHand: z.number().nullable().optional(),
  individualContributions: z.number().nullable().optional(),
  pacContributions: z.number().nullable().optional(),
  smallDonorContributions: z.number().nullable().optional(),
  selfFunding: z.number().nullable().optional(),
  party: z.string().max(20).nullable().optional(),
  officeType: z.string().max(30).nullable().optional(),
  state: z.string().max(5).nullable().optional(),
  district: z.string().max(10).nullable().optional(),
  fecCandidateId: z.string().max(20).nullable().optional(),
  sourceUrl: z.string().max(2000).nullable().optional(),
  dataAsOf: z.string().max(20).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

// ---- Helpers ----

const politicianEntity = alias(entities, "politician_entity");

interface FinanceRow {
  finance: typeof campaignFinance.$inferSelect;
  politicianTitle: string | null;
  politicianSlug: string | null;
}

function formatRow(r: FinanceRow) {
  const f = r.finance;
  return {
    id: f.id,
    politicianEntityId: f.politicianEntityId,
    politicianDisplayName: f.politicianDisplayName,
    politician: formatEntityRef(
      f.politicianEntityId,
      r.politicianSlug,
      r.politicianTitle,
      f.politicianDisplayName,
      f.politicianEntityId,
    ),
    cycle: f.cycle,
    totalRaised: f.totalRaised ? Number(f.totalRaised) : null,
    totalSpent: f.totalSpent ? Number(f.totalSpent) : null,
    cashOnHand: f.cashOnHand ? Number(f.cashOnHand) : null,
    individualContributions: f.individualContributions
      ? Number(f.individualContributions)
      : null,
    pacContributions: f.pacContributions
      ? Number(f.pacContributions)
      : null,
    smallDonorContributions: f.smallDonorContributions
      ? Number(f.smallDonorContributions)
      : null,
    selfFunding: f.selfFunding ? Number(f.selfFunding) : null,
    party: f.party,
    officeType: f.officeType,
    state: f.state,
    district: f.district,
    fecCandidateId: f.fecCandidateId,
    sourceUrl: f.sourceUrl,
    dataAsOf: f.dataAsOf,
    notes: f.notes,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

// ---- Route ----

const campaignFinanceApp = new Hono()

  // GET /stats
  .get("/stats", async (c) => {
    const db = getDrizzleDb();
    const [row] = await db
      .select({
        total: count(),
        totalRaisedSum: sum(campaignFinance.totalRaised),
        politicians: sql<number>`count(distinct politician_entity_id)`,
        cycles: sql<number>`count(distinct cycle)`,
      })
      .from(campaignFinance);

    // Top fundraisers (top 10 by total raised)
    const topFundraisers = await db
      .select({
        finance: campaignFinance,
        politicianTitle: politicianEntity.title,
        politicianSlug: politicianEntity.id,
      })
      .from(campaignFinance)
      .leftJoin(
        politicianEntity,
        eq(campaignFinance.politicianEntityId, politicianEntity.stableId),
      )
      .orderBy(desc(campaignFinance.totalRaised))
      .limit(10);

    return c.json({
      total: row.total,
      totalRaisedSum: row.totalRaisedSum ? Number(row.totalRaisedSum) : 0,
      politicians: Number(row.politicians),
      cycles: Number(row.cycles),
      topFundraisers: topFundraisers.map(formatRow),
    });
  })

  // GET /all
  .get("/all", zv("query", ListQuery), async (c) => {
    const { limit, offset, cycle, state, officeType, party } =
      c.req.valid("query");
    const db = getDrizzleDb();

    const conditions: SQL[] = [];
    if (cycle) conditions.push(eq(campaignFinance.cycle, cycle));
    if (state) conditions.push(eq(campaignFinance.state, state));
    if (officeType)
      conditions.push(eq(campaignFinance.officeType, officeType));
    if (party) conditions.push(eq(campaignFinance.party, party));

    const where =
      conditions.length === 0
        ? undefined
        : conditions.length === 1
          ? conditions[0]
          : and(...conditions);

    const { rows, total } = await paginatedQuery({
      query: db
        .select({
          finance: campaignFinance,
          politicianTitle: politicianEntity.title,
          politicianSlug: politicianEntity.id,
        })
        .from(campaignFinance)
        .leftJoin(
          politicianEntity,
          eq(campaignFinance.politicianEntityId, politicianEntity.stableId),
        )
        .where(where)
        .orderBy(desc(campaignFinance.totalRaised))
        .limit(limit)
        .offset(offset),
      countQuery: db.select({ count: count() }).from(campaignFinance).where(where),
      formatRow,
    });

    return c.json({ records: rows, total, limit, offset });
  })

  // GET /by-entity/:entityId
  .get("/by-entity/:entityId", async (c) => {
    const entityId = c.req.param("entityId");
    const db = getDrizzleDb();

    const rows = await db
      .select({
        finance: campaignFinance,
        politicianTitle: politicianEntity.title,
        politicianSlug: politicianEntity.id,
      })
      .from(campaignFinance)
      .leftJoin(
        politicianEntity,
        eq(campaignFinance.politicianEntityId, politicianEntity.stableId),
      )
      .where(eq(campaignFinance.politicianEntityId, entityId))
      .orderBy(desc(campaignFinance.cycle));

    return c.json({ records: rows.map(formatRow), total: rows.length });
  })

  // POST /sync — uses sync-factory
  .post(
    "/sync",
    createSyncHandler({
      name: "campaign-finance",
      table: campaignFinance,
      syncSchema: SyncItemSchema,
      entityRefs: ["politicianEntityId"],
      toRow: (item, now) => {
        const numericOrNull = (v: number | null | undefined): string | null =>
          v != null ? String(v) : null;
        return {
          id: item.id,
          politicianEntityId: item.politicianEntityId ?? null,
          politicianDisplayName: item.politicianDisplayName ?? null,
          cycle: item.cycle,
          totalRaised: numericOrNull(item.totalRaised),
          totalSpent: numericOrNull(item.totalSpent),
          cashOnHand: numericOrNull(item.cashOnHand),
          individualContributions: numericOrNull(item.individualContributions),
          pacContributions: numericOrNull(item.pacContributions),
          smallDonorContributions: numericOrNull(item.smallDonorContributions),
          selfFunding: numericOrNull(item.selfFunding),
          party: item.party ?? null,
          officeType: item.officeType ?? null,
          state: item.state ?? null,
          district: item.district ?? null,
          fecCandidateId: item.fecCandidateId ?? null,
          sourceUrl: item.sourceUrl ?? null,
          dataAsOf: item.dataAsOf ?? null,
          notes: item.notes ?? null,
          syncedAt: now,
          updatedAt: now,
        };
      },
    }),
  )

  .post("/delete-batch", deleteBatchHandler(campaignFinance, null));

export const campaignFinanceRoute = campaignFinanceApp;
export type CampaignFinanceRoute = typeof campaignFinanceApp;
