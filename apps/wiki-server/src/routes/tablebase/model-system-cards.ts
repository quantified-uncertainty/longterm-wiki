import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, desc, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { modelSystemCards, entities } from "../../schema.js";
import {
  zv,
  clampedLimit,
  noDuplicateIds,
  notFoundError,
} from "../shared/utils.js";
import { paginatedQuery } from "../shared/paginated-query.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { createSyncHandler } from "./sync-factory.js";
import { alias } from "drizzle-orm/pg-core";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

// Allowlist mirrors the CHECK constraint in migration 0204.
const VALID_SOURCE_FORMATS = [
  "pdf",
  "html",
  "markdown",
  "arxiv-paper",
  "missing",
] as const;

// ---- Query schemas ----

const AllQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 100),
  offset: z.coerce.number().int().min(0).default(0),
  ai_model_id: z.string().max(200).optional(),
  safety_framework: z.string().max(100).optional(),
});

const ByModelQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 100),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Sync schemas ----
//
// Hand-written Zod schema per `.claude/rules/tablebase-sync-factory.md` —
// captures business rules (URL length caps, controlled vocab, shape of
// eval_scores_cited / third_party_evals arrays) that would require
// override surface the same size as the schema if we derived from
// drizzle-zod.

const EvalScoreSchema = z.object({
  benchmark: z.string().min(1).max(200),
  benchmarkId: z.string().max(200).nullable().optional(),
  score: z.number(),
  metric: z.string().max(100).nullable().optional(),
  setup: z.string().max(200).nullable().optional(),
  excerpt: z.string().max(4000).nullable().optional(),
});

const ThirdPartyEvalSchema = z.object({
  evaluator: z.string().min(1).max(200),
  url: z.string().max(2000).nullable().optional(),
  summary: z.string().max(2000).nullable().optional(),
  excerpt: z.string().max(4000).nullable().optional(),
});

const SyncModelSystemCardItemSchema = z.object({
  id: z.string().regex(
    /^[A-Za-z0-9_-]{10}$/,
    "id must be 10 alphanumeric characters (hyphens and underscores allowed)",
  ),
  aiModelId: z.string().min(1).max(200),
  aiModelDisplayName: z.string().max(500).nullable().optional(),
  version: z.string().max(100).nullable().optional(),
  releaseDate: z.string().max(20).nullable().optional(), // ISO date string
  deprecationDate: z.string().max(20).nullable().optional(),
  trainingCutoff: z.string().max(20).nullable().optional(),
  trainingComputeFlops: z.number().nonnegative().nullable().optional(),
  trainingGpuHours: z.number().nonnegative().nullable().optional(),
  trainingHardware: z.string().max(200).nullable().optional(),
  parametersTotal: z.number().int().nonnegative().nullable().optional(),
  parametersActive: z.number().int().nonnegative().nullable().optional(),
  architecture: z.string().max(100).nullable().optional(),
  modalitiesIn: z.array(z.string().max(50)).max(20).nullable().optional(),
  modalitiesOut: z.array(z.string().max(50)).max(20).nullable().optional(),
  contextWindowTokens: z.number().int().nonnegative().nullable().optional(),
  outputWindowTokens: z.number().int().nonnegative().nullable().optional(),
  languagesSupported: z.array(z.string().max(50)).max(200).nullable().optional(),
  safetyFramework: z.string().max(50).nullable().optional(),
  safetyTier: z.string().max(100).nullable().optional(),
  safetyTierDomains: z.record(z.string().max(50)).nullable().optional(),
  safeguardsSummary: z.string().max(10_000).nullable().optional(),
  classifierDetails: z.record(z.unknown()).nullable().optional(),
  fineTuningPolicy: z.string().max(100).nullable().optional(),
  deploymentChannels: z.array(z.string().max(50)).max(30).nullable().optional(),
  evalScoresCited: z.array(EvalScoreSchema).max(200).nullable().optional(),
  thirdPartyEvals: z.array(ThirdPartyEvalSchema).max(50).nullable().optional(),
  redTeamSummary: z.string().max(10_000).nullable().optional(),
  incidentDisclosures: z.string().max(10_000).nullable().optional(),
  sourceUrl: z.string().min(1).max(2000),
  sourceFormat: z.enum(VALID_SOURCE_FORMATS).nullable().optional(),
  sourceHash: z.string().max(200).nullable().optional(),
  waybackSnapshotUrl: z.string().max(2000).nullable().optional(),
  systemPromptUrl: z.string().max(2000).nullable().optional(),
  usagePolicyUrl: z.string().max(2000).nullable().optional(),
  extractedAt: z.string().nullable().optional(), // ISO timestamp
  extractorVersion: z.string().max(100).nullable().optional(),
  extractionModel: z.string().max(200).nullable().optional(),
  extractionConfidence: z.record(z.number().min(0).max(1)).nullable().optional(),
  notes: z.string().max(10_000).nullable().optional(),
});

const SyncModelSystemCardsBatchSchema = z.object({
  items: z
    .array(SyncModelSystemCardItemSchema)
    .min(1)
    .max(500)
    .refine(noDuplicateIds, { message: "Duplicate id values in items array" }),
});

// ---- Helpers ----

const modelEntity = alias(entities, "model_entity");

interface CardRow {
  card: typeof modelSystemCards.$inferSelect;
  modelTitle: string | null;
  modelSlug: string | null;
}

function formatRow(r: CardRow) {
  const c = r.card;
  return {
    ...c,
    trainingComputeFlops: c.trainingComputeFlops == null ? null : Number(c.trainingComputeFlops),
    trainingGpuHours: c.trainingGpuHours == null ? null : Number(c.trainingGpuHours),
    aiModel: {
      id: c.aiModelId,
      slug: r.modelSlug,
      title: r.modelTitle,
      displayName: c.aiModelDisplayName ?? r.modelTitle ?? c.aiModelId,
    },
  };
}

// ---- Route definition (method-chained for Hono RPC type inference) ----

const modelSystemCardsApp = new Hono()

  // ---- GET /stats ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const [row] = await db
      .select({
        total: count(),
        models: sql<number>`count(distinct ${modelSystemCards.aiModelId})`,
        withSafetyTier: sql<number>`count(*) filter (where ${modelSystemCards.safetyTier} is not null)`,
        withComputeFlops: sql<number>`count(*) filter (where ${modelSystemCards.trainingComputeFlops} is not null)`,
        withParameters: sql<number>`count(*) filter (where ${modelSystemCards.parametersTotal} is not null)`,
      })
      .from(modelSystemCards);

    return c.json({
      total: row.total,
      models: Number(row.models),
      withSafetyTier: Number(row.withSafetyTier),
      withComputeFlops: Number(row.withComputeFlops),
      withParameters: Number(row.withParameters),
    });
  })

  // ---- GET /all ----
  .get("/all", zv("query", AllQuery), async (c) => {
    const { limit, offset, ai_model_id, safety_framework } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions: SQL[] = [];
    if (ai_model_id) conditions.push(eq(modelSystemCards.aiModelId, ai_model_id));
    if (safety_framework) conditions.push(eq(modelSystemCards.safetyFramework, safety_framework));

    const where =
      conditions.length === 0
        ? undefined
        : conditions.length === 1
          ? conditions[0]
          : and(...conditions);

    const { rows, total } = await paginatedQuery({
      query: db
        .select({
          card: modelSystemCards,
          modelTitle: modelEntity.title,
          modelSlug: modelEntity.id,
        })
        .from(modelSystemCards)
        .leftJoin(modelEntity, eq(modelSystemCards.aiModelId, modelEntity.stableId))
        .where(where)
        .orderBy(desc(modelSystemCards.releaseDate), desc(modelSystemCards.syncedAt))
        .limit(limit)
        .offset(offset),
      countQuery: db
        .select({ count: count() })
        .from(modelSystemCards)
        .where(where),
      formatRow,
    });

    return c.json({ items: rows, total, limit, offset });
  })

  // ---- GET /by-model/:modelId ----
  .get("/by-model/:modelId", zv("query", ByModelQuery), async (c) => {
    const modelId = c.req.param("modelId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const where = eq(modelSystemCards.aiModelId, modelId);
    const { rows, total } = await paginatedQuery({
      query: db
        .select({
          card: modelSystemCards,
          modelTitle: modelEntity.title,
          modelSlug: modelEntity.id,
        })
        .from(modelSystemCards)
        .leftJoin(modelEntity, eq(modelSystemCards.aiModelId, modelEntity.stableId))
        .where(where)
        .orderBy(desc(modelSystemCards.releaseDate), desc(modelSystemCards.syncedAt))
        .limit(limit)
        .offset(offset),
      countQuery: db
        .select({ count: count() })
        .from(modelSystemCards)
        .where(where),
      formatRow,
    });

    return c.json({ modelId, items: rows, total, limit, offset });
  })

  // ---- GET /by-entity/:entityId — factory registry convention ----
  .get("/by-entity/:entityId", zv("query", ByModelQuery), async (c) => {
    const entityId = c.req.param("entityId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const where = eq(modelSystemCards.aiModelId, entityId);
    const { rows, total } = await paginatedQuery({
      query: db
        .select({
          card: modelSystemCards,
          modelTitle: modelEntity.title,
          modelSlug: modelEntity.id,
        })
        .from(modelSystemCards)
        .leftJoin(modelEntity, eq(modelSystemCards.aiModelId, modelEntity.stableId))
        .where(where)
        .orderBy(desc(modelSystemCards.releaseDate), desc(modelSystemCards.syncedAt))
        .limit(limit)
        .offset(offset),
      countQuery: db
        .select({ count: count() })
        .from(modelSystemCards)
        .where(where),
      formatRow,
    });

    return c.json({ entityId, items: rows, total, limit, offset });
  })

  // ---- GET /:id ----
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const db = getDrizzleDb();

    const rows = await db
      .select({
        card: modelSystemCards,
        modelTitle: modelEntity.title,
        modelSlug: modelEntity.id,
      })
      .from(modelSystemCards)
      .leftJoin(modelEntity, eq(modelSystemCards.aiModelId, modelEntity.stableId))
      .where(eq(modelSystemCards.id, id))
      .limit(1);

    if (rows.length === 0) {
      return notFoundError(c, `Model system card ${id} not found`);
    }

    return c.json(formatRow(rows[0]));
  })

  // ---- POST /sync — uses sync-factory ----
  .post(
    "/sync",
    createSyncHandler({
      name: "model-system-cards",
      table: modelSystemCards,
      batchSchema: SyncModelSystemCardsBatchSchema,
      entityRefs: ["aiModelId"],
      // Drizzle's numeric() insert type is `string`; Zod schema emits
      // numbers. Custom toRow to coerce just the two numeric columns
      // and let the factory handle the rest.
      toRow: (item, now) => ({
        ...item,
        trainingComputeFlops:
          item.trainingComputeFlops != null ? String(item.trainingComputeFlops) : null,
        trainingGpuHours:
          item.trainingGpuHours != null ? String(item.trainingGpuHours) : null,
        syncedAt: now,
        updatedAt: now,
      }),
      // Preserve existing non-null fields when a sync payload sends null.
      // Extractors that only populate a subset of fields must not blow
      // away previous, more-complete data for the same row.
      conflictSet: {
        aiModelId: sql`excluded.ai_model_id`,
        aiModelDisplayName: sql`COALESCE(excluded.ai_model_display_name, ${modelSystemCards.aiModelDisplayName})`,
        version: sql`COALESCE(excluded.version, ${modelSystemCards.version})`,
        releaseDate: sql`COALESCE(excluded.release_date, ${modelSystemCards.releaseDate})`,
        deprecationDate: sql`COALESCE(excluded.deprecation_date, ${modelSystemCards.deprecationDate})`,
        trainingCutoff: sql`COALESCE(excluded.training_cutoff, ${modelSystemCards.trainingCutoff})`,
        trainingComputeFlops: sql`COALESCE(excluded.training_compute_flops, ${modelSystemCards.trainingComputeFlops})`,
        trainingGpuHours: sql`COALESCE(excluded.training_gpu_hours, ${modelSystemCards.trainingGpuHours})`,
        trainingHardware: sql`COALESCE(excluded.training_hardware, ${modelSystemCards.trainingHardware})`,
        parametersTotal: sql`COALESCE(excluded.parameters_total, ${modelSystemCards.parametersTotal})`,
        parametersActive: sql`COALESCE(excluded.parameters_active, ${modelSystemCards.parametersActive})`,
        architecture: sql`COALESCE(excluded.architecture, ${modelSystemCards.architecture})`,
        modalitiesIn: sql`COALESCE(excluded.modalities_in, ${modelSystemCards.modalitiesIn})`,
        modalitiesOut: sql`COALESCE(excluded.modalities_out, ${modelSystemCards.modalitiesOut})`,
        contextWindowTokens: sql`COALESCE(excluded.context_window_tokens, ${modelSystemCards.contextWindowTokens})`,
        outputWindowTokens: sql`COALESCE(excluded.output_window_tokens, ${modelSystemCards.outputWindowTokens})`,
        languagesSupported: sql`COALESCE(excluded.languages_supported, ${modelSystemCards.languagesSupported})`,
        safetyFramework: sql`COALESCE(excluded.safety_framework, ${modelSystemCards.safetyFramework})`,
        safetyTier: sql`COALESCE(excluded.safety_tier, ${modelSystemCards.safetyTier})`,
        safetyTierDomains: sql`COALESCE(excluded.safety_tier_domains, ${modelSystemCards.safetyTierDomains})`,
        safeguardsSummary: sql`COALESCE(excluded.safeguards_summary, ${modelSystemCards.safeguardsSummary})`,
        classifierDetails: sql`COALESCE(excluded.classifier_details, ${modelSystemCards.classifierDetails})`,
        fineTuningPolicy: sql`COALESCE(excluded.fine_tuning_policy, ${modelSystemCards.fineTuningPolicy})`,
        deploymentChannels: sql`COALESCE(excluded.deployment_channels, ${modelSystemCards.deploymentChannels})`,
        evalScoresCited: sql`COALESCE(excluded.eval_scores_cited, ${modelSystemCards.evalScoresCited})`,
        thirdPartyEvals: sql`COALESCE(excluded.third_party_evals, ${modelSystemCards.thirdPartyEvals})`,
        redTeamSummary: sql`COALESCE(excluded.red_team_summary, ${modelSystemCards.redTeamSummary})`,
        incidentDisclosures: sql`COALESCE(excluded.incident_disclosures, ${modelSystemCards.incidentDisclosures})`,
        sourceUrl: sql`excluded.source_url`,
        sourceFormat: sql`COALESCE(excluded.source_format, ${modelSystemCards.sourceFormat})`,
        sourceHash: sql`COALESCE(excluded.source_hash, ${modelSystemCards.sourceHash})`,
        waybackSnapshotUrl: sql`COALESCE(excluded.wayback_snapshot_url, ${modelSystemCards.waybackSnapshotUrl})`,
        systemPromptUrl: sql`COALESCE(excluded.system_prompt_url, ${modelSystemCards.systemPromptUrl})`,
        usagePolicyUrl: sql`COALESCE(excluded.usage_policy_url, ${modelSystemCards.usagePolicyUrl})`,
        extractedAt: sql`COALESCE(excluded.extracted_at, ${modelSystemCards.extractedAt})`,
        extractorVersion: sql`COALESCE(excluded.extractor_version, ${modelSystemCards.extractorVersion})`,
        extractionModel: sql`COALESCE(excluded.extraction_model, ${modelSystemCards.extractionModel})`,
        extractionConfidence: sql`COALESCE(excluded.extraction_confidence, ${modelSystemCards.extractionConfidence})`,
        notes: sql`COALESCE(excluded.notes, ${modelSystemCards.notes})`,
        syncedAt: sql`now()`,
        updatedAt: sql`now()`,
      },
      auditRecordType: "model_system_cards",
      // Things dual-write: model system cards are surfaced in search so
      // users land directly on the card detail view rather than only via
      // the parent AI model entity.
      thingsTitleIds: (items) => [
        ...new Set(items.map((c) => c.aiModelId)),
      ],
      toThing: (item, titleMap) => {
        const parentTitle = titleMap.get(item.aiModelId) ?? item.aiModelDisplayName ?? item.aiModelId;
        const versionPart = item.version ? ` ${item.version}` : "";
        const datePart = item.releaseDate ? ` (${item.releaseDate})` : "";
        return {
          id: item.id,
          thingType: "model-system-card" as const,
          title: `${parentTitle}${versionPart} — System Card${datePart}`,
          description: item.safetyTier
            ? `${item.safetyFramework ?? "Safety"} tier: ${item.safetyTier}`
            : (item.safeguardsSummary?.slice(0, 200) ?? null),
          parentTitle,
          sourceTable: "model_system_cards",
          sourceId: item.id,
          sourceUrl: item.sourceUrl,
        };
      },
    }),
  )

  .post("/delete-batch", deleteBatchHandler(modelSystemCards, "model_system_cards"));

// ---- Exports ----

export const modelSystemCardsRoute = modelSystemCardsApp;
export type ModelSystemCardsRoute = typeof modelSystemCardsApp;
