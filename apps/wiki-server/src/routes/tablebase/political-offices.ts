import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDrizzleDb } from "../../db.js";
import { logger } from "../../logger.js";
import { politicalOffices, entities } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
} from "../shared/utils.js";
import { formatEntityRef } from "../shared/entity-ref.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 500;

const VALID_OFFICE_TYPES = [
  "senator",
  "representative",
  "governor",
  "state_senator",
  "state_representative",
  "attorney_general",
  "other",
] as const;

const VALID_STATUSES = ["incumbent", "candidate", "former"] as const;

const VALID_PARTIES = [
  "democratic",
  "republican",
  "independent",
  "other",
] as const;

// ---- Query schemas ----

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(200),
  offset: z.coerce.number().int().min(0).default(0),
  politicianEntityId: z.string().max(200).optional(),
  officeType: z.string().max(100).optional(),
  jurisdiction: z.string().max(50).optional(),
  party: z.string().max(50).optional(),
  status: z.string().max(50).optional(),
});

// ---- Sync schemas ----

const SyncItemSchema = z.object({
  id: z.string().length(10),
  politicianEntityId: z.string().min(1).max(200),
  politicianDisplayName: z.string().max(500).nullable().optional(),
  officeType: z.enum(VALID_OFFICE_TYPES),
  jurisdiction: z.string().min(1).max(50),
  district: z.string().max(50).nullable().optional(),
  party: z.enum(VALID_PARTIES).nullable().optional(),
  status: z.enum(VALID_STATUSES).default("incumbent"),
  termStart: z.string().max(20).nullable().optional(),
  termEnd: z.string().max(20).nullable().optional(),
  sourceUrl: z.string().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const SyncBatchSchema = z.object({
  items: z.array(SyncItemSchema).min(1).max(200),
});

// ---- Helpers ----

const politicianEntity = alias(entities, "politician_entity");

interface OfficeRow {
  office: typeof politicalOffices.$inferSelect;
  politicianTitle: string | null;
  politicianSlug: string | null;
}

function formatRow(r: OfficeRow) {
  const o = r.office;
  return {
    id: o.id,
    politicianEntityId: o.politicianEntityId,
    politicianDisplayName: o.politicianDisplayName,
    politician: formatEntityRef(
      o.politicianEntityId,
      r.politicianSlug,
      r.politicianTitle,
      o.politicianDisplayName,
      o.politicianEntityId,
    ),
    officeType: o.officeType,
    jurisdiction: o.jurisdiction,
    district: o.district,
    party: o.party,
    status: o.status,
    termStart: o.termStart,
    termEnd: o.termEnd,
    sourceUrl: o.sourceUrl,
    notes: o.notes,
    syncedAt: o.syncedAt,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

// ---- Route ----

const politicalOfficesApp = new Hono()

  // GET /stats
  .get("/stats", async (c) => {
    const db = getDrizzleDb();
    const [row] = await db
      .select({
        total: count(),
        incumbents: sql<number>`count(*) filter (where ${politicalOffices.status} = 'incumbent')`,
        candidates: sql<number>`count(*) filter (where ${politicalOffices.status} = 'candidate')`,
        former: sql<number>`count(*) filter (where ${politicalOffices.status} = 'former')`,
      })
      .from(politicalOffices);

    return c.json({
      total: row.total,
      incumbents: Number(row.incumbents),
      candidates: Number(row.candidates),
      former: Number(row.former),
    });
  })

  // GET /all
  .get("/all", zv("query", ListQuery), async (c) => {
    const { limit, offset, politicianEntityId, officeType, jurisdiction, party, status } =
      c.req.valid("query");
    const db = getDrizzleDb();

    const conditions: SQL[] = [];
    if (politicianEntityId)
      conditions.push(eq(politicalOffices.politicianEntityId, politicianEntityId));
    if (officeType)
      conditions.push(eq(politicalOffices.officeType, officeType));
    if (jurisdiction)
      conditions.push(eq(politicalOffices.jurisdiction, jurisdiction));
    if (party) conditions.push(eq(politicalOffices.party, party));
    if (status) conditions.push(eq(politicalOffices.status, status));

    const where =
      conditions.length === 0
        ? undefined
        : conditions.length === 1
          ? conditions[0]
          : and(...conditions);

    const rows = await db
      .select({
        office: politicalOffices,
        politicianTitle: politicianEntity.title,
        politicianSlug: politicianEntity.id,
      })
      .from(politicalOffices)
      .leftJoin(
        politicianEntity,
        eq(politicalOffices.politicianEntityId, politicianEntity.stableId),
      )
      .where(where)
      .orderBy(politicalOffices.status, politicalOffices.officeType)
      .limit(limit)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: count() })
      .from(politicalOffices)
      .where(where);

    return c.json({ offices: rows.map(formatRow), total, limit, offset });
  })

  // GET /by-entity/:entityId
  .get("/by-entity/:entityId", async (c) => {
    const entityId = c.req.param("entityId");
    const db = getDrizzleDb();

    const rows = await db
      .select({
        office: politicalOffices,
        politicianTitle: politicianEntity.title,
        politicianSlug: politicianEntity.id,
      })
      .from(politicalOffices)
      .leftJoin(
        politicianEntity,
        eq(politicalOffices.politicianEntityId, politicianEntity.stableId),
      )
      .where(eq(politicalOffices.politicianEntityId, entityId))
      .orderBy(politicalOffices.status, politicalOffices.termStart);

    return c.json({ offices: rows.map(formatRow), total: rows.length });
  })

  // POST /sync
  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;
    const db = getDrizzleDb();

    logger.info(`sync political-offices: upserting ${items.length} offices`);

    let upserted = 0;
    const now = new Date();

    await db.transaction(async (tx) => {
      for (const item of items) {
        await tx
          .insert(politicalOffices)
          .values({
            id: item.id,
            politicianEntityId: item.politicianEntityId,
            politicianDisplayName: item.politicianDisplayName ?? null,
            officeType: item.officeType,
            jurisdiction: item.jurisdiction,
            district: item.district ?? null,
            party: item.party ?? null,
            status: item.status,
            termStart: item.termStart ?? null,
            termEnd: item.termEnd ?? null,
            sourceUrl: item.sourceUrl ?? null,
            notes: item.notes ?? null,
            syncedAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: politicalOffices.id,
            set: {
              politicianEntityId: item.politicianEntityId,
              politicianDisplayName: item.politicianDisplayName ?? null,
              officeType: item.officeType,
              jurisdiction: item.jurisdiction,
              district: item.district ?? null,
              party: item.party ?? null,
              status: item.status,
              termStart: item.termStart ?? null,
              termEnd: item.termEnd ?? null,
              sourceUrl: item.sourceUrl ?? null,
              notes: item.notes ?? null,
              syncedAt: now,
              updatedAt: now,
            },
          });
        upserted++;
      }
    });

    return c.json({ upserted });
  });

export const politicalOfficesRoute = politicalOfficesApp;
export type PoliticalOfficesRoute = typeof politicalOfficesApp;
