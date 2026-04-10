import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, desc, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDrizzleDb } from "../../db.js";
import { logger } from "../../logger.js";
import { politicalScores, entities } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
  clampedLimit,
} from "../shared/utils.js";
import { formatEntityRef } from "../shared/entity-ref.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { validateEntityRefs } from "../shared/validate-entity-refs.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 500;

const VALID_SCORE_TYPES = [
  "environmental",
  "animal_welfare",
  "foreign_policy",
  "nuclear",
  "civil_liberties",
  "conservative",
  "progressive",
  "business",
  "labor",
  "overall",
] as const;

// ---- Query schemas ----

const ListQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 200),
  offset: z.coerce.number().int().min(0).default(0),
  politicianEntityId: z.string().max(200).optional(),
  scorerOrg: z.string().max(100).optional(),
  year: z.coerce.number().int().optional(),
  scoreType: z.string().max(100).optional(),
});

// ---- Sync schemas ----

const SyncItemSchema = z.object({
  id: z.string().length(10),
  politicianEntityId: z.string().min(1).max(200),
  politicianDisplayName: z.string().max(500).nullable().optional(),
  scorerOrg: z.string().min(1).max(100),
  scorerEntityId: z.string().min(1).max(200).nullable().optional(),
  score: z.number().min(0).max(1000),
  maxScore: z.number().min(1).max(1000).default(100),
  year: z.number().int().min(1900).max(2100),
  scoreType: z.string().max(100).nullable().optional(),
  sourceUrl: z.string().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const SyncBatchSchema = z.object({
  items: z.array(SyncItemSchema).min(1).max(200),
});

// ---- Helpers ----

const politicianEntity = alias(entities, "politician_entity");
const scorerEntity = alias(entities, "scorer_entity");

interface ScoreRow {
  score: typeof politicalScores.$inferSelect;
  politicianTitle: string | null;
  politicianSlug: string | null;
  scorerTitle: string | null;
  scorerSlug: string | null;
}

function formatRow(r: ScoreRow) {
  const s = r.score;
  return {
    id: s.id,
    politicianEntityId: s.politicianEntityId,
    politicianDisplayName: s.politicianDisplayName,
    politician: formatEntityRef(
      s.politicianEntityId,
      r.politicianSlug,
      r.politicianTitle,
      s.politicianDisplayName,
      s.politicianEntityId,
    ),
    scorerOrg: s.scorerOrg,
    scorerEntityId: s.scorerEntityId,
    scorer: formatEntityRef(
      s.scorerEntityId,
      r.scorerSlug,
      r.scorerTitle,
      null,
      s.scorerEntityId,
    ),
    score: Number(s.score),
    maxScore: Number(s.maxScore),
    year: s.year,
    scoreType: s.scoreType,
    sourceUrl: s.sourceUrl,
    notes: s.notes,
    syncedAt: s.syncedAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

// ---- Route ----

const politicalScoresApp = new Hono()

  // GET /stats
  .get("/stats", async (c) => {
    const db = getDrizzleDb();
    const [row] = await db
      .select({
        total: count(),
        scorerOrgs: sql<number>`count(distinct scorer_org)`,
        politicians: sql<number>`count(distinct politician_entity_id)`,
      })
      .from(politicalScores);

    return c.json({
      total: row.total,
      scorerOrgs: Number(row.scorerOrgs),
      politicians: Number(row.politicians),
    });
  })

  // GET /all
  .get("/all", zv("query", ListQuery), async (c) => {
    const { limit, offset, politicianEntityId, scorerOrg, year, scoreType } =
      c.req.valid("query");
    const db = getDrizzleDb();

    const conditions: SQL[] = [];
    if (politicianEntityId)
      conditions.push(eq(politicalScores.politicianEntityId, politicianEntityId));
    if (scorerOrg)
      conditions.push(eq(politicalScores.scorerOrg, scorerOrg));
    if (year)
      conditions.push(eq(politicalScores.year, year));
    if (scoreType)
      conditions.push(eq(politicalScores.scoreType, scoreType));

    const where =
      conditions.length === 0
        ? undefined
        : conditions.length === 1
          ? conditions[0]
          : and(...conditions);

    const rows = await db
      .select({
        score: politicalScores,
        politicianTitle: politicianEntity.title,
        politicianSlug: politicianEntity.id,
        scorerTitle: scorerEntity.title,
        scorerSlug: scorerEntity.id,
      })
      .from(politicalScores)
      .leftJoin(
        politicianEntity,
        eq(politicalScores.politicianEntityId, politicianEntity.stableId),
      )
      .leftJoin(
        scorerEntity,
        eq(politicalScores.scorerEntityId, scorerEntity.stableId),
      )
      .where(where)
      .orderBy(desc(politicalScores.year), politicalScores.scorerOrg)
      .limit(limit)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: count() })
      .from(politicalScores)
      .where(where);

    return c.json({ scores: rows.map(formatRow), total, limit, offset });
  })

  // GET /by-entity/:entityId
  .get("/by-entity/:entityId", async (c) => {
    const entityId = c.req.param("entityId");
    const db = getDrizzleDb();

    const rows = await db
      .select({
        score: politicalScores,
        politicianTitle: politicianEntity.title,
        politicianSlug: politicianEntity.id,
        scorerTitle: scorerEntity.title,
        scorerSlug: scorerEntity.id,
      })
      .from(politicalScores)
      .leftJoin(
        politicianEntity,
        eq(politicalScores.politicianEntityId, politicianEntity.stableId),
      )
      .leftJoin(
        scorerEntity,
        eq(politicalScores.scorerEntityId, scorerEntity.stableId),
      )
      .where(eq(politicalScores.politicianEntityId, entityId))
      .orderBy(desc(politicalScores.year), politicalScores.scorerOrg);

    return c.json({ scores: rows.map(formatRow), total: rows.length });
  })

  // POST /sync
  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;
    const db = getDrizzleDb();

    const refError = await validateEntityRefs(c, db, [
      { fieldName: "politicianEntityId", ids: items.map((i) => i.politicianEntityId) },
      { fieldName: "scorerEntityId", ids: items.map((i) => i.scorerEntityId).filter((id): id is string => id != null) },
    ]);
    if (refError) return refError;

    logger.info(`sync political-scores: upserting ${items.length} scores`);

    let upserted = 0;

    await db.transaction(async (tx) => {
      for (const item of items) {
        await tx
          .insert(politicalScores)
          .values({
            id: item.id,
            politicianEntityId: item.politicianEntityId,
            politicianDisplayName: item.politicianDisplayName ?? null,
            scorerOrg: item.scorerOrg,
            scorerEntityId: item.scorerEntityId ?? null,
            score: String(item.score),
            maxScore: String(item.maxScore),
            year: item.year,
            scoreType: item.scoreType ?? null,
            sourceUrl: item.sourceUrl ?? null,
            notes: item.notes ?? null,
            syncedAt: new Date(),
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: politicalScores.id,
            set: {
              politicianEntityId: item.politicianEntityId,
              politicianDisplayName: item.politicianDisplayName ?? null,
              scorerOrg: item.scorerOrg,
              scorerEntityId: item.scorerEntityId ?? null,
              score: String(item.score),
              maxScore: String(item.maxScore),
              year: item.year,
              scoreType: item.scoreType ?? null,
              sourceUrl: item.sourceUrl ?? null,
              notes: item.notes ?? null,
              syncedAt: new Date(),
              updatedAt: new Date(),
            },
          });
        upserted++;
      }
    });

    return c.json({ upserted });
  })

  .post("/delete-batch", deleteBatchHandler(politicalScores, null));

export const politicalScoresRoute = politicalScoresApp;
export type PoliticalScoresRoute = typeof politicalScoresApp;
