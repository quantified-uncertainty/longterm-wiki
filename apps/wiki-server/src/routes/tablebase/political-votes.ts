import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, desc, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDrizzleDb } from "../../db.js";
import { logger } from "../../logger.js";
import { politicalVotes, entities } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
  clampedLimit,
} from "../shared/utils.js";
import { formatEntityRef } from "../shared/entity-ref.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 500;

const VALID_VOTES = [
  "yea",
  "nay",
  "abstain",
  "not_voting",
  "present",
] as const;

const VALID_CHAMBERS = [
  "senate",
  "house",
  "state_senate",
  "state_assembly",
] as const;

// ---- Query schemas ----

const ListQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 200),
  offset: z.coerce.number().int().min(0).default(0),
  chamber: z.string().max(50).optional(),
  vote: z.string().max(20).optional(),
  legislationEntityId: z.string().max(200).optional(),
  congressNumber: z.coerce.number().int().optional(),
});

// ---- Sync schemas ----

const SyncItemSchema = z.object({
  id: z.string().length(10),
  politicianEntityId: z.string().min(1).max(40).nullable().optional(),
  politicianDisplayName: z.string().max(200).nullable().optional(),
  legislationEntityId: z.string().max(100).nullable().optional(),
  legislationTitle: z.string().max(500).nullable().optional(),
  vote: z.enum(VALID_VOTES),
  voteDate: z.string().max(20).nullable().optional(),
  chamber: z.string().max(20).nullable().optional(),
  rollCallNumber: z.number().int().nullable().optional(),
  congressNumber: z.number().int().nullable().optional(),
  session: z.number().int().min(1).max(2).nullable().optional(),
  sourceUrl: z.string().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const SyncBatchSchema = z.object({
  items: z.array(SyncItemSchema).min(1).max(200),
});

// ---- Helpers ----

const politicianEntity = alias(entities, "politician_entity");
const legislationEntity = alias(entities, "legislation_entity");

interface VoteRow {
  vote: typeof politicalVotes.$inferSelect;
  politicianTitle: string | null;
  politicianSlug: string | null;
  legislationTitle: string | null;
  legislationSlug: string | null;
  legislationStableId: string | null;
}

function formatRow(r: VoteRow) {
  const v = r.vote;
  return {
    id: v.id,
    politicianEntityId: v.politicianEntityId,
    politicianDisplayName: v.politicianDisplayName,
    politician: formatEntityRef(
      v.politicianEntityId,
      r.politicianSlug,
      r.politicianTitle,
      v.politicianDisplayName,
      v.politicianEntityId,
    ),
    legislationEntityId: v.legislationEntityId,
    legislationTitle: v.legislationTitle,
    legislation: formatEntityRef(
      r.legislationStableId,
      r.legislationSlug,
      r.legislationTitle,
      v.legislationTitle,
      v.legislationEntityId,
    ),
    vote: v.vote,
    voteDate: v.voteDate,
    chamber: v.chamber,
    rollCallNumber: v.rollCallNumber,
    congressNumber: v.congressNumber,
    session: v.session,
    sourceUrl: v.sourceUrl,
    notes: v.notes,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

/** Base select query with entity joins */
function baseSelect(db: ReturnType<typeof getDrizzleDb>) {
  return db
    .select({
      vote: politicalVotes,
      politicianTitle: politicianEntity.title,
      politicianSlug: politicianEntity.id,
      legislationTitle: legislationEntity.title,
      legislationSlug: legislationEntity.id,
      legislationStableId: legislationEntity.stableId,
    })
    .from(politicalVotes)
    .leftJoin(
      politicianEntity,
      eq(politicalVotes.politicianEntityId, politicianEntity.stableId),
    )
    .leftJoin(
      legislationEntity,
      eq(politicalVotes.legislationEntityId, legislationEntity.id),
    );
}

// ---- Route ----

const politicalVotesApp = new Hono()

  // GET /stats
  .get("/stats", async (c) => {
    const db = getDrizzleDb();
    const [row] = await db
      .select({
        total: count(),
        politicians: sql<number>`count(distinct politician_entity_id)`,
        legislation: sql<number>`count(distinct legislation_entity_id)`,
        chambers: sql<number>`count(distinct chamber)`,
      })
      .from(politicalVotes);

    // Vote breakdown
    const voteBreakdown = await db
      .select({
        vote: politicalVotes.vote,
        count: count(),
      })
      .from(politicalVotes)
      .groupBy(politicalVotes.vote);

    const breakdown: Record<string, number> = {};
    for (const vb of voteBreakdown) {
      breakdown[vb.vote] = vb.count;
    }

    return c.json({
      total: row.total,
      politicians: Number(row.politicians),
      legislation: Number(row.legislation),
      chambers: Number(row.chambers),
      breakdown,
    });
  })

  // GET /all — list with pagination and filters
  .get("/all", zv("query", ListQuery), async (c) => {
    const { limit, offset, chamber, vote, legislationEntityId, congressNumber } =
      c.req.valid("query");
    const db = getDrizzleDb();

    const conditions: SQL[] = [];
    if (chamber)
      conditions.push(eq(politicalVotes.chamber, chamber));
    if (vote)
      conditions.push(eq(politicalVotes.vote, vote));
    if (legislationEntityId)
      conditions.push(eq(politicalVotes.legislationEntityId, legislationEntityId));
    if (congressNumber)
      conditions.push(eq(politicalVotes.congressNumber, congressNumber));

    const where =
      conditions.length === 0
        ? undefined
        : conditions.length === 1
          ? conditions[0]
          : and(...conditions);

    const rows = await baseSelect(db)
      .where(where)
      .orderBy(desc(politicalVotes.voteDate), politicalVotes.chamber)
      .limit(limit)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: count() })
      .from(politicalVotes)
      .where(where);

    return c.json({ votes: rows.map(formatRow), total, limit, offset });
  })

  // GET /by-entity/:entityId — all votes for a politician
  .get("/by-entity/:entityId", async (c) => {
    const entityId = c.req.param("entityId");
    const db = getDrizzleDb();

    const rows = await baseSelect(db)
      .where(eq(politicalVotes.politicianEntityId, entityId))
      .orderBy(desc(politicalVotes.voteDate), politicalVotes.chamber);

    return c.json({ votes: rows.map(formatRow), total: rows.length });
  })

  // GET /by-legislation/:legislationId — all votes on a piece of legislation
  .get("/by-legislation/:legislationId", async (c) => {
    const legislationId = c.req.param("legislationId");
    const db = getDrizzleDb();

    const rows = await baseSelect(db)
      .where(eq(politicalVotes.legislationEntityId, legislationId))
      .orderBy(politicalVotes.vote, politicalVotes.politicianDisplayName);

    // Compute vote breakdown for this legislation
    const breakdown = await db
      .select({
        vote: politicalVotes.vote,
        count: count(),
      })
      .from(politicalVotes)
      .where(eq(politicalVotes.legislationEntityId, legislationId))
      .groupBy(politicalVotes.vote);

    const voteSummary: Record<string, number> = {};
    for (const vb of breakdown) {
      voteSummary[vb.vote] = vb.count;
    }

    return c.json({
      votes: rows.map(formatRow),
      total: rows.length,
      breakdown: voteSummary,
    });
  })

  // POST /sync — batch upsert
  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;
    const db = getDrizzleDb();

    logger.info(`sync political-votes: upserting ${items.length} votes`);

    let upserted = 0;

    await db.transaction(async (tx) => {
      for (const item of items) {
        await tx
          .insert(politicalVotes)
          .values({
            id: item.id,
            politicianEntityId: item.politicianEntityId ?? null,
            politicianDisplayName: item.politicianDisplayName ?? null,
            legislationEntityId: item.legislationEntityId ?? null,
            legislationTitle: item.legislationTitle ?? null,
            vote: item.vote,
            voteDate: item.voteDate ?? null,
            chamber: item.chamber ?? null,
            rollCallNumber: item.rollCallNumber ?? null,
            congressNumber: item.congressNumber ?? null,
            session: item.session ?? null,
            sourceUrl: item.sourceUrl ?? null,
            notes: item.notes ?? null,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: politicalVotes.id,
            set: {
              politicianEntityId: item.politicianEntityId ?? null,
              politicianDisplayName: item.politicianDisplayName ?? null,
              legislationEntityId: item.legislationEntityId ?? null,
              legislationTitle: item.legislationTitle ?? null,
              vote: item.vote,
              voteDate: item.voteDate ?? null,
              chamber: item.chamber ?? null,
              rollCallNumber: item.rollCallNumber ?? null,
              congressNumber: item.congressNumber ?? null,
              session: item.session ?? null,
              sourceUrl: item.sourceUrl ?? null,
              notes: item.notes ?? null,
              updatedAt: new Date(),
            },
          });
        upserted++;
      }
    });

    return c.json({ upserted });
  });

export const politicalVotesRoute = politicalVotesApp;
export type PoliticalVotesRoute = typeof politicalVotesApp;
