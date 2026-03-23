import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, desc, asc, sql, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDrizzleDb } from "../../db.js";
import {
  predictionMarketQuestions,
  predictionMarketSnapshots,
  entities,
} from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
} from "../shared/utils.js";
import {
  resolveEntityId,
  type ResolvedEntityVars,
} from "../shared/resolve-entity-middleware.js";
import { formatEntityRef } from "../shared/entity-ref.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 500;

const VALID_PLATFORMS = [
  "metaculus",
  "polymarket",
  "manifold",
] as const;

const VALID_QUESTION_TYPES = [
  "binary",
  "numeric",
  "multiple_choice",
] as const;

// ---- Query schemas ----

const QuestionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(200),
  offset: z.coerce.number().int().min(0).default(0),
  platform: z.string().optional(),
  category: z.string().optional(),
  isResolved: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

const ByEntityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(200),
  offset: z.coerce.number().int().min(0).default(0),
  platform: z.string().optional(),
  category: z.string().optional(),
  isResolved: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

const TimeseriesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(500),
});

// ---- Sync schemas ----

const SyncQuestionItemSchema = z.object({
  id: z.string().length(10),
  platform: z.enum(VALID_PLATFORMS),
  platformQuestionId: z.string().min(1).max(200),
  entityId: z.string().max(200).nullable().optional(),
  entityDisplayName: z.string().max(500).nullable().optional(),
  questionText: z.string().min(1).max(5000),
  questionUrl: z.string().max(2000).nullable().optional(),
  resolutionDate: z.string().max(20).nullable().optional(),
  resolutionCriteria: z.string().max(5000).nullable().optional(),
  questionType: z.enum(VALID_QUESTION_TYPES).default("binary"),
  category: z.string().max(100).nullable().optional(),
  isResolved: z.boolean().default(false),
  resolutionValue: z.number().nullable().optional(),
  resolutionNotes: z.string().max(5000).nullable().optional(),
  currentProbability: z.number().min(0).max(1).nullable().optional(),
  discoveryMethod: z.string().max(50).nullable().optional(),
  source: z.string().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const SyncQuestionsBatchSchema = z.object({
  items: z.array(SyncQuestionItemSchema).min(1).max(500),
});

const SyncSnapshotItemSchema = z.object({
  id: z.string().length(10),
  questionId: z.string().length(10),
  date: z.string().min(4).max(20),
  probability: z.number().min(0).max(1).nullable().optional(),
  probabilityLow: z.number().min(0).max(1).nullable().optional(),
  probabilityHigh: z.number().min(0).max(1).nullable().optional(),
  numForecasters: z.number().int().nullable().optional(),
  volume: z.number().nullable().optional(),
  openInterest: z.number().nullable().optional(),
  communityPrediction: z.number().min(0).max(1).nullable().optional(),
  source: z.string().max(2000).nullable().optional(),
});

const SyncSnapshotsBatchSchema = z.object({
  items: z.array(SyncSnapshotItemSchema).min(1).max(500),
});

// ---- Helpers ----

const linkedEntity = alias(entities, "linked_entity");

interface QuestionRow {
  question: typeof predictionMarketQuestions.$inferSelect;
  entityTitle: string | null;
  entitySlug: string | null;
}

function formatQuestionRow(r: QuestionRow) {
  const q = r.question;
  const entityRef = formatEntityRef(
    q.entityId,
    r.entitySlug,
    r.entityTitle,
    q.entityDisplayName,
    q.entityId
  );
  return {
    id: q.id,
    platform: q.platform,
    platformQuestionId: q.platformQuestionId,
    questionText: q.questionText,
    questionUrl: q.questionUrl,
    resolutionDate: q.resolutionDate,
    resolutionCriteria: q.resolutionCriteria,
    questionType: q.questionType,
    category: q.category,
    isResolved: q.isResolved,
    resolutionValue:
      q.resolutionValue != null ? Number(q.resolutionValue) : null,
    resolutionNotes: q.resolutionNotes,
    currentProbability:
      q.currentProbability != null ? Number(q.currentProbability) : null,
    discoveryMethod: q.discoveryMethod,
    source: q.source,
    notes: q.notes,
    entity: entityRef,
    entityId: q.entityId,
    entityDisplayName: q.entityDisplayName,
    syncedAt: q.syncedAt,
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
  };
}

function toNum(v: number | null | undefined): string | null {
  return v != null ? String(v) : null;
}

// ---- Route definition (method-chained for Hono RPC type inference) ----

const predictionMarketsApp = new Hono<{ Variables: ResolvedEntityVars }>()

  // ---- GET /stats ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const [statsRow] = await db
      .select({
        totalQuestions: count(),
        resolvedCount: sql<number>`count(*) filter (where ${predictionMarketQuestions.isResolved} = true)`,
        uniqueEntities: sql<number>`count(distinct ${predictionMarketQuestions.entityId})`,
        uniquePlatforms: sql<number>`count(distinct ${predictionMarketQuestions.platform})`,
      })
      .from(predictionMarketQuestions);

    const [snapshotStats] = await db
      .select({
        totalSnapshots: count(),
        latestDate: sql<string>`max(${predictionMarketSnapshots.date})`,
        earliestDate: sql<string>`min(${predictionMarketSnapshots.date})`,
      })
      .from(predictionMarketSnapshots);

    return c.json({
      totalQuestions: statsRow.totalQuestions,
      resolvedCount: Number(statsRow.resolvedCount),
      activeCount:
        statsRow.totalQuestions - Number(statsRow.resolvedCount),
      uniqueEntities: Number(statsRow.uniqueEntities),
      uniquePlatforms: Number(statsRow.uniquePlatforms),
      totalSnapshots: snapshotStats.totalSnapshots,
      latestSnapshotDate: snapshotStats.latestDate,
      earliestSnapshotDate: snapshotStats.earliestDate,
    });
  })

  // ---- GET /questions ----
  .get("/questions", zv("query", QuestionsQuery), async (c) => {
    const { limit, offset, platform, category, isResolved } =
      c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [];
    if (platform)
      conditions.push(eq(predictionMarketQuestions.platform, platform));
    if (category)
      conditions.push(eq(predictionMarketQuestions.category, category));
    if (isResolved !== undefined)
      conditions.push(
        eq(predictionMarketQuestions.isResolved, isResolved)
      );

    const whereClause =
      conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select({
        question: predictionMarketQuestions,
        entityTitle: linkedEntity.title,
        entitySlug: linkedEntity.id,
      })
      .from(predictionMarketQuestions)
      .leftJoin(
        linkedEntity,
        eq(predictionMarketQuestions.entityId, linkedEntity.stableId)
      )
      .where(whereClause)
      .orderBy(
        desc(predictionMarketQuestions.updatedAt),
        predictionMarketQuestions.id
      )
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(predictionMarketQuestions)
      .where(whereClause);
    const total = countResult[0].count;

    return c.json({
      questions: rows.map(formatQuestionRow),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /questions/by-entity/:entityId ----
  .get(
    "/questions/by-entity/:entityId",
    resolveEntityId(),
    zv("query", ByEntityQuery),
    async (c) => {
      const resolvedId = c.get("resolvedEntityId");
      const { limit, offset, platform, category, isResolved } =
        c.req.valid("query");
      const db = getDrizzleDb();

      const conditions = [
        eq(predictionMarketQuestions.entityId, resolvedId),
      ];
      if (platform)
        conditions.push(eq(predictionMarketQuestions.platform, platform));
      if (category)
        conditions.push(eq(predictionMarketQuestions.category, category));
      if (isResolved !== undefined)
        conditions.push(
          eq(predictionMarketQuestions.isResolved, isResolved)
        );

      const whereClause = and(...conditions);

      const rows = await db
        .select({
          question: predictionMarketQuestions,
          entityTitle: linkedEntity.title,
          entitySlug: linkedEntity.id,
        })
        .from(predictionMarketQuestions)
        .leftJoin(
          linkedEntity,
          eq(predictionMarketQuestions.entityId, linkedEntity.stableId)
        )
        .where(whereClause)
        .orderBy(
          desc(predictionMarketQuestions.updatedAt),
          predictionMarketQuestions.id
        )
        .limit(limit)
        .offset(offset);

      const countResult = await db
        .select({ count: count() })
        .from(predictionMarketQuestions)
        .where(whereClause);
      const total = countResult[0].count;

      return c.json({
        entityId: resolvedId,
        questions: rows.map(formatQuestionRow),
        total,
        limit,
        offset,
      });
    }
  )

  // ---- GET /snapshots/timeseries/:questionId ----
  .get(
    "/snapshots/timeseries/:questionId",
    zv("query", TimeseriesQuery),
    async (c) => {
      const questionId = c.req.param("questionId");
      const { limit } = c.req.valid("query");
      const db = getDrizzleDb();

      const rows = await db
        .select({
          date: predictionMarketSnapshots.date,
          probability: predictionMarketSnapshots.probability,
          probabilityLow: predictionMarketSnapshots.probabilityLow,
          probabilityHigh: predictionMarketSnapshots.probabilityHigh,
          numForecasters: predictionMarketSnapshots.numForecasters,
          volume: predictionMarketSnapshots.volume,
          communityPrediction:
            predictionMarketSnapshots.communityPrediction,
        })
        .from(predictionMarketSnapshots)
        .where(eq(predictionMarketSnapshots.questionId, questionId))
        .orderBy(asc(predictionMarketSnapshots.date))
        .limit(limit);

      return c.json({
        questionId,
        points: rows.map((r) => ({
          date: r.date,
          probability:
            r.probability != null ? Number(r.probability) : null,
          probabilityLow:
            r.probabilityLow != null ? Number(r.probabilityLow) : null,
          probabilityHigh:
            r.probabilityHigh != null ? Number(r.probabilityHigh) : null,
          numForecasters: r.numForecasters,
          volume: r.volume != null ? Number(r.volume) : null,
          communityPrediction:
            r.communityPrediction != null
              ? Number(r.communityPrediction)
              : null,
        })),
        total: rows.length,
      });
    }
  )

  // ---- POST /questions/sync ----
  .post("/questions/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncQuestionsBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;
    const db = getDrizzleDb();

    let upserted = 0;

    await db.transaction(async (tx) => {
      const allVals = items.map((item) => ({
        id: item.id,
        platform: item.platform,
        platformQuestionId: item.platformQuestionId,
        entityId: item.entityId ?? null,
        entityDisplayName: item.entityDisplayName ?? null,
        questionText: item.questionText,
        questionUrl: item.questionUrl ?? null,
        resolutionDate: item.resolutionDate ?? null,
        resolutionCriteria: item.resolutionCriteria ?? null,
        questionType: item.questionType,
        category: item.category ?? null,
        isResolved: item.isResolved,
        resolutionValue: toNum(item.resolutionValue),
        resolutionNotes: item.resolutionNotes ?? null,
        currentProbability: toNum(item.currentProbability),
        discoveryMethod: item.discoveryMethod ?? null,
        source: item.source ?? null,
        notes: item.notes ?? null,
      }));

      await tx
        .insert(predictionMarketQuestions)
        .values(allVals)
        .onConflictDoUpdate({
          target: [
            predictionMarketQuestions.platform,
            predictionMarketQuestions.platformQuestionId,
          ],
          set: {
            entityId: sql`excluded.entity_id`,
            entityDisplayName: sql`excluded.entity_display_name`,
            questionText: sql`excluded.question_text`,
            questionUrl: sql`excluded.question_url`,
            resolutionDate: sql`excluded.resolution_date`,
            resolutionCriteria: sql`excluded.resolution_criteria`,
            questionType: sql`excluded.question_type`,
            category: sql`excluded.category`,
            isResolved: sql`excluded.is_resolved`,
            resolutionValue: sql`excluded.resolution_value`,
            resolutionNotes: sql`excluded.resolution_notes`,
            currentProbability: sql`excluded.current_probability`,
            discoveryMethod: sql`excluded.discovery_method`,
            source: sql`excluded.source`,
            notes: sql`excluded.notes`,
            syncedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        });

      upserted = allVals.length;
    });

    return c.json({ upserted });
  })

  // ---- POST /snapshots/sync ----
  .post("/snapshots/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncSnapshotsBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;
    const db = getDrizzleDb();

    let upserted = 0;

    await db.transaction(async (tx) => {
      const allVals = items.map((item) => ({
        id: item.id,
        questionId: item.questionId,
        date: item.date,
        probability: toNum(item.probability),
        probabilityLow: toNum(item.probabilityLow),
        probabilityHigh: toNum(item.probabilityHigh),
        numForecasters: item.numForecasters ?? null,
        volume: toNum(item.volume),
        openInterest: toNum(item.openInterest),
        communityPrediction: toNum(item.communityPrediction),
        source: item.source ?? null,
      }));

      await tx
        .insert(predictionMarketSnapshots)
        .values(allVals)
        .onConflictDoUpdate({
          target: [
            predictionMarketSnapshots.questionId,
            predictionMarketSnapshots.date,
          ],
          set: {
            probability: sql`excluded.probability`,
            probabilityLow: sql`excluded.probability_low`,
            probabilityHigh: sql`excluded.probability_high`,
            numForecasters: sql`excluded.num_forecasters`,
            volume: sql`excluded.volume`,
            openInterest: sql`excluded.open_interest`,
            communityPrediction: sql`excluded.community_prediction`,
            source: sql`excluded.source`,
            syncedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        });

      upserted = allVals.length;

      // Denormalize latest probability onto the question records in bulk.
      // Uses a single UPDATE...FROM subquery instead of N+1 sequential queries.
      const questionIds = [...new Set(items.map((i) => i.questionId))];
      if (questionIds.length > 0) {
        await tx.execute(sql`
          UPDATE prediction_market_questions q
          SET current_probability = sub.probability,
              updated_at = now()
          FROM (
            SELECT DISTINCT ON (question_id)
              question_id, probability
            FROM prediction_market_snapshots
            WHERE question_id = ANY(${questionIds})
            ORDER BY question_id, date DESC
          ) sub
          WHERE q.id = sub.question_id
        `);
      }
    });

    return c.json({ upserted });
  });

// ---- Exports ----

export const predictionMarketsRoute = predictionMarketsApp;
export type PredictionMarketsRoute = typeof predictionMarketsApp;
