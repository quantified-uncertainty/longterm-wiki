/**
 * Third-party evaluations route (QUA-692).
 *
 * Indexes published pre-deployment evaluations and red-team reports from
 * UK AISI, US AISI / CAISI, METR, and Apollo Research. The report is the
 * natural key (`reportUrl`); a single report can cover N models, captured
 * via `third_party_evaluation_models`.
 *
 * Sync items carry an inline `models[]` array describing the model fan-out.
 * The factory upserts the report row; the postUpsert hook synchronizes the
 * join table inside the same transaction (delete-then-insert per id) so
 * partial syncs that drop a previously-linked model don't leave stale rows.
 */
import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, desc, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { getDrizzleDb } from "../../db.js";
import {
  thirdPartyEvaluations,
  thirdPartyEvaluationModels,
  entities,
} from "../../schema.js";
import {
  zv,
  clampedLimit,
  noDuplicateIds,
  notFoundError,
} from "../shared/utils.js";
import { paginatedQuery } from "../shared/paginated-query.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { sqlInList } from "../shared/query-helpers.js";
import { createSyncHandler } from "./sync-factory.js";
import { InlineSourcingSchema } from "./sourcing-schema.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

const RECORD_TYPE = "third-party-evaluation" as const;

// Canonical definition lives in api-types.ts so the worker container can
// reach it; re-imported here both for local use and to keep the existing
// re-export shape for old call sites.
import { VALID_RISK_DOMAINS } from "../../api-types.js";
export { VALID_RISK_DOMAINS };

export const VALID_SOURCE_FORMATS = [
  "pdf",
  "html",
  "markdown",
  "arxiv-paper",
  "missing",
] as const;

export const VALID_SOURCE_SYSTEMS = [
  "sitemap",
  "rss",
  "html-scrape",
  "manual",
] as const;

export const VALID_MATCH_CONFIDENCES = ["exact", "fuzzy", "manual"] as const;

// ---- Query schemas ----

const AllQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 100),
  offset: z.coerce.number().int().min(0).default(0),
  evaluator_org_id: z.string().max(200).optional(),
  pre_deployment: z.enum(["true", "false"]).optional(),
});

const ByEvaluatorQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 100),
  offset: z.coerce.number().int().min(0).default(0),
});

const ByModelQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 100),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Sync schemas ----
//
// Hand-written per `docs/agent-rules/tablebase-sync-factory.md` — captures
// business rules (URL caps, controlled vocab, model fan-out shape) that
// drizzle-zod inference cannot derive.

const EvaluationModelLinkSchema = z.object({
  aiModelId: z.string().min(1).max(200),
  aiModelDisplayName: z.string().max(500).nullable().optional(),
  rawNameInReport: z.string().max(500).nullable().optional(),
  matchConfidence: z.enum(VALID_MATCH_CONFIDENCES),
});

const SyncThirdPartyEvalItemSchema = z.object({
  id: z.string().regex(
    /^[A-Za-z0-9_-]{10}$/,
    "id must be 10 alphanumeric characters (hyphens and underscores allowed)",
  ),
  evaluatorOrgId: z.string().min(1).max(200),
  evaluatorOrgDisplayName: z.string().max(500).nullable().optional(),
  reportUrl: z.string().min(1).max(2000),
  reportPdfUrl: z.string().max(2000).nullable().optional(),
  title: z.string().min(1).max(1000),
  publishedDate: z.string().max(20).nullable().optional(), // ISO date string
  riskDomain: z
    .array(z.enum(VALID_RISK_DOMAINS))
    .min(1)
    .max(VALID_RISK_DOMAINS.length),
  preDeployment: z.boolean().nullable().optional(),
  findingsSummary: z.string().max(4000).nullable().optional(),
  capabilityLevelsAssessed: z.record(z.string().max(200)).nullable().optional(),
  methodologyUrl: z.string().max(2000).nullable().optional(),
  sourceFormat: z.enum(VALID_SOURCE_FORMATS).nullable().optional(),
  sourceHash: z.string().max(200).nullable().optional(),
  waybackSnapshotUrl: z.string().max(2000).nullable().optional(),
  sourceSystem: z.enum(VALID_SOURCE_SYSTEMS),
  extractedAt: z.string().nullable().optional(), // ISO timestamp
  extractorVersion: z.string().max(100).nullable().optional(),
  extractionModel: z.string().max(200).nullable().optional(),
  extractionConfidence: z.record(z.number().min(0).max(1)).nullable().optional(),
  notes: z.string().max(10_000).nullable().optional(),
  // Inline join-table fan-out. Empty array clears all links for this evaluation;
  // omitted (undefined) leaves existing links untouched (partial sync).
  models: z.array(EvaluationModelLinkSchema).max(50).optional(),
  // When present, the sync handler writes a source_check_verdicts row
  // atomically with the evaluation. Ingesters populate this from span-verify
  // output via `spanVerifyToInlineSourcing()`.
  sourcing: InlineSourcingSchema.optional(),
});

export type ThirdPartyEvaluationSyncItem = z.infer<typeof SyncThirdPartyEvalItemSchema>;

const SyncThirdPartyEvaluationsBatchSchema = z.object({
  items: z
    .array(SyncThirdPartyEvalItemSchema)
    .min(1)
    .max(500)
    .refine(noDuplicateIds, { message: "Duplicate id values in items array" }),
});

// ---- Helpers ----

const evaluatorEntity = alias(entities, "evaluator_entity");

interface EvalRow {
  evaluation: typeof thirdPartyEvaluations.$inferSelect;
  evaluatorTitle: string | null;
  evaluatorSlug: string | null;
}

function formatRow(r: EvalRow) {
  const e = r.evaluation;
  return {
    ...e,
    evaluator: {
      id: e.evaluatorOrgId,
      slug: r.evaluatorSlug,
      title: r.evaluatorTitle,
      displayName: e.evaluatorOrgDisplayName ?? r.evaluatorTitle ?? e.evaluatorOrgId,
    },
  };
}

// ---- Route definition (method-chained for Hono RPC type inference) ----

const thirdPartyEvaluationsApp = new Hono()

  // ---- GET /stats ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const [row] = await db
      .select({
        total: count(),
        evaluators: sql<number>`count(distinct ${thirdPartyEvaluations.evaluatorOrgId})`,
        preDeployment: sql<number>`count(*) filter (where ${thirdPartyEvaluations.preDeployment} = true)`,
        postDeployment: sql<number>`count(*) filter (where ${thirdPartyEvaluations.preDeployment} = false)`,
        ambiguousDeployment: sql<number>`count(*) filter (where ${thirdPartyEvaluations.preDeployment} is null)`,
      })
      .from(thirdPartyEvaluations);

    return c.json({
      total: row.total,
      evaluators: Number(row.evaluators),
      preDeployment: Number(row.preDeployment),
      postDeployment: Number(row.postDeployment),
      ambiguousDeployment: Number(row.ambiguousDeployment),
    });
  })

  // ---- GET /all ----
  .get("/all", zv("query", AllQuery), async (c) => {
    const { limit, offset, evaluator_org_id, pre_deployment } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions: SQL[] = [];
    if (evaluator_org_id)
      conditions.push(eq(thirdPartyEvaluations.evaluatorOrgId, evaluator_org_id));
    if (pre_deployment !== undefined)
      conditions.push(eq(thirdPartyEvaluations.preDeployment, pre_deployment === "true"));

    const where =
      conditions.length === 0
        ? undefined
        : conditions.length === 1
          ? conditions[0]
          : and(...conditions);

    const { rows, total } = await paginatedQuery({
      query: db
        .select({
          evaluation: thirdPartyEvaluations,
          evaluatorTitle: evaluatorEntity.title,
          evaluatorSlug: evaluatorEntity.id,
        })
        .from(thirdPartyEvaluations)
        .leftJoin(
          evaluatorEntity,
          eq(thirdPartyEvaluations.evaluatorOrgId, evaluatorEntity.stableId),
        )
        .where(where)
        .orderBy(
          desc(thirdPartyEvaluations.publishedDate),
          desc(thirdPartyEvaluations.syncedAt),
        )
        .limit(limit)
        .offset(offset),
      countQuery: db
        .select({ count: count() })
        .from(thirdPartyEvaluations)
        .where(where),
      formatRow,
    });

    return c.json({ items: rows, total, limit, offset });
  })

  // ---- GET /by-evaluator/:evaluatorId ----
  .get("/by-evaluator/:evaluatorId", zv("query", ByEvaluatorQuery), async (c) => {
    const evaluatorId = c.req.param("evaluatorId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const where = eq(thirdPartyEvaluations.evaluatorOrgId, evaluatorId);
    const { rows, total } = await paginatedQuery({
      query: db
        .select({
          evaluation: thirdPartyEvaluations,
          evaluatorTitle: evaluatorEntity.title,
          evaluatorSlug: evaluatorEntity.id,
        })
        .from(thirdPartyEvaluations)
        .leftJoin(
          evaluatorEntity,
          eq(thirdPartyEvaluations.evaluatorOrgId, evaluatorEntity.stableId),
        )
        .where(where)
        .orderBy(desc(thirdPartyEvaluations.publishedDate))
        .limit(limit)
        .offset(offset),
      countQuery: db
        .select({ count: count() })
        .from(thirdPartyEvaluations)
        .where(where),
      formatRow,
    });

    return c.json({ evaluatorId, items: rows, total, limit, offset });
  })

  // ---- GET /by-model/:modelId — joins via the fan-out table ----
  .get("/by-model/:modelId", zv("query", ByModelQuery), async (c) => {
    const modelId = c.req.param("modelId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    // Inner-join the fan-out so we only return reports linked to this model.
    const baseQuery = db
      .select({
        evaluation: thirdPartyEvaluations,
        evaluatorTitle: evaluatorEntity.title,
        evaluatorSlug: evaluatorEntity.id,
      })
      .from(thirdPartyEvaluations)
      .innerJoin(
        thirdPartyEvaluationModels,
        eq(thirdPartyEvaluations.id, thirdPartyEvaluationModels.evaluationId),
      )
      .leftJoin(
        evaluatorEntity,
        eq(thirdPartyEvaluations.evaluatorOrgId, evaluatorEntity.stableId),
      )
      .where(eq(thirdPartyEvaluationModels.aiModelId, modelId))
      .orderBy(desc(thirdPartyEvaluations.publishedDate))
      .limit(limit)
      .offset(offset);

    const countQuery = db
      .select({ count: count() })
      .from(thirdPartyEvaluations)
      .innerJoin(
        thirdPartyEvaluationModels,
        eq(thirdPartyEvaluations.id, thirdPartyEvaluationModels.evaluationId),
      )
      .where(eq(thirdPartyEvaluationModels.aiModelId, modelId));

    const { rows, total } = await paginatedQuery({
      query: baseQuery,
      countQuery,
      formatRow,
    });

    return c.json({ modelId, items: rows, total, limit, offset });
  })

  // ---- GET /by-entity/:entityId — registry convention; treats entity as evaluator ----
  .get("/by-entity/:entityId", zv("query", ByEvaluatorQuery), async (c) => {
    const entityId = c.req.param("entityId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const where = eq(thirdPartyEvaluations.evaluatorOrgId, entityId);
    const { rows, total } = await paginatedQuery({
      query: db
        .select({
          evaluation: thirdPartyEvaluations,
          evaluatorTitle: evaluatorEntity.title,
          evaluatorSlug: evaluatorEntity.id,
        })
        .from(thirdPartyEvaluations)
        .leftJoin(
          evaluatorEntity,
          eq(thirdPartyEvaluations.evaluatorOrgId, evaluatorEntity.stableId),
        )
        .where(where)
        .orderBy(desc(thirdPartyEvaluations.publishedDate))
        .limit(limit)
        .offset(offset),
      countQuery: db
        .select({ count: count() })
        .from(thirdPartyEvaluations)
        .where(where),
      formatRow,
    });

    return c.json({ entityId, items: rows, total, limit, offset });
  })

  // ---- GET /:id (with model fan-out included) ----
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const db = getDrizzleDb();

    const rows = await db
      .select({
        evaluation: thirdPartyEvaluations,
        evaluatorTitle: evaluatorEntity.title,
        evaluatorSlug: evaluatorEntity.id,
      })
      .from(thirdPartyEvaluations)
      .leftJoin(
        evaluatorEntity,
        eq(thirdPartyEvaluations.evaluatorOrgId, evaluatorEntity.stableId),
      )
      .where(eq(thirdPartyEvaluations.id, id))
      .limit(1);

    if (rows.length === 0) {
      return notFoundError(c, `Third-party evaluation ${id} not found`);
    }

    const models = await db
      .select()
      .from(thirdPartyEvaluationModels)
      .where(eq(thirdPartyEvaluationModels.evaluationId, id));

    return c.json({ ...formatRow(rows[0]), models });
  })

  // ---- POST /sync — uses sync-factory ----
  .post(
    "/sync",
    createSyncHandler({
      name: "third-party-evaluations",
      table: thirdPartyEvaluations,
      batchSchema: SyncThirdPartyEvaluationsBatchSchema,
      entityRefs: ["evaluatorOrgId"],
      // Strip the `models` and `sourcing` fields before insert — `models`
      // goes to the join table in postUpsert; `sourcing` goes to
      // source_check_verdicts via toVerdict. Coerce `extractedAt` from the
      // wire-format ISO string into a Date so postgres-js can serialize the
      // timestamp column (it calls `.toISOString()` internally).
      toRow: (item, now) => {
        const { models: _models, sourcing: _sourcing, extractedAt, ...row } = item;
        void _models;
        void _sourcing;
        return {
          ...row,
          extractedAt: extractedAt ? new Date(extractedAt) : null,
          syncedAt: now,
          updatedAt: now,
        };
      },
      // Preserve existing non-null fields when extractors send partial data.
      // `reportUrl`, `riskDomain`, `sourceSystem`, `evaluatorOrgId`, and
      // `title` are required on every payload, so we always overwrite them.
      conflictSet: {
        evaluatorOrgId: sql`excluded.evaluator_org_id`,
        evaluatorOrgDisplayName: sql`COALESCE(excluded.evaluator_org_display_name, ${thirdPartyEvaluations.evaluatorOrgDisplayName})`,
        reportUrl: sql`excluded.report_url`,
        reportPdfUrl: sql`COALESCE(excluded.report_pdf_url, ${thirdPartyEvaluations.reportPdfUrl})`,
        title: sql`excluded.title`,
        publishedDate: sql`COALESCE(excluded.published_date, ${thirdPartyEvaluations.publishedDate})`,
        riskDomain: sql`excluded.risk_domain`,
        preDeployment: sql`COALESCE(excluded.pre_deployment, ${thirdPartyEvaluations.preDeployment})`,
        findingsSummary: sql`COALESCE(excluded.findings_summary, ${thirdPartyEvaluations.findingsSummary})`,
        capabilityLevelsAssessed: sql`COALESCE(excluded.capability_levels_assessed, ${thirdPartyEvaluations.capabilityLevelsAssessed})`,
        methodologyUrl: sql`COALESCE(excluded.methodology_url, ${thirdPartyEvaluations.methodologyUrl})`,
        sourceFormat: sql`COALESCE(excluded.source_format, ${thirdPartyEvaluations.sourceFormat})`,
        sourceHash: sql`COALESCE(excluded.source_hash, ${thirdPartyEvaluations.sourceHash})`,
        waybackSnapshotUrl: sql`COALESCE(excluded.wayback_snapshot_url, ${thirdPartyEvaluations.waybackSnapshotUrl})`,
        sourceSystem: sql`excluded.source_system`,
        extractedAt: sql`COALESCE(excluded.extracted_at, ${thirdPartyEvaluations.extractedAt})`,
        extractorVersion: sql`COALESCE(excluded.extractor_version, ${thirdPartyEvaluations.extractorVersion})`,
        extractionModel: sql`COALESCE(excluded.extraction_model, ${thirdPartyEvaluations.extractionModel})`,
        extractionConfidence: sql`COALESCE(excluded.extraction_confidence, ${thirdPartyEvaluations.extractionConfidence})`,
        notes: sql`COALESCE(excluded.notes, ${thirdPartyEvaluations.notes})`,
        syncedAt: sql`now()`,
        updatedAt: sql`now()`,
      },
      auditRecordType: "third_party_evaluations",
      // Things dual-write — pointer-only post-QUA-507. Display fields are
      // composed at read time from the source table.
      toThing: (item) => ({
        id: item.id,
        thingType: RECORD_TYPE,
        parentThingId: item.evaluatorOrgId,
        sourceTable: "third_party_evaluations",
        sourceId: item.id,
        sourceUrl: item.reportUrl,
      }),
      // Ingesters that ran span-verify populate `item.sourcing`; the factory
      // writes source_check_verdicts atomically with the row. Items without
      // `sourcing` skip this phase.
      toVerdict: (item) => ({
        recordType: RECORD_TYPE,
        recordId: item.id,
        entityId: item.evaluatorOrgId,
        sourceUrl: item.reportUrl,
        sourcing: item.sourcing ?? null,
      }),
      // Synchronize the join-table fan-out inside the same transaction.
      // Items where `models` is undefined leave existing links untouched
      // (allowing partial syncs to update the report row without forcing
      // a re-link). Items with `models: []` clear the fan-out explicitly.
      postUpsert: async (tx, items) => {
        const itemsWithModels = items.filter(
          (i): i is ThirdPartyEvaluationSyncItem & { models: NonNullable<ThirdPartyEvaluationSyncItem["models"]> } =>
            i.models !== undefined,
        );
        if (itemsWithModels.length === 0) return;

        const evaluationIds = itemsWithModels.map((i) => i.id);
        // Delete existing links for evaluations being synced. Bounded by
        // the batch size so this is O(batch * existing_links) with the
        // PK supporting the inArray scan.
        await tx
          .delete(thirdPartyEvaluationModels)
          .where(sql`${thirdPartyEvaluationModels.evaluationId} IN (${sqlInList(evaluationIds)})`);

        const now = new Date();
        const linkRows: Array<{
          evaluationId: string;
          aiModelId: string;
          aiModelDisplayName: string | null;
          rawNameInReport: string | null;
          matchConfidence: string;
          createdAt: Date;
        }> = [];

        for (const item of itemsWithModels) {
          for (const link of item.models) {
            linkRows.push({
              evaluationId: item.id,
              aiModelId: link.aiModelId,
              aiModelDisplayName: link.aiModelDisplayName ?? null,
              rawNameInReport: link.rawNameInReport ?? null,
              matchConfidence: link.matchConfidence,
              createdAt: now,
            });
          }
        }

        if (linkRows.length > 0) {
          await tx.insert(thirdPartyEvaluationModels).values(linkRows);
        }
      },
    }),
  )

  .post(
    "/delete-batch",
    deleteBatchHandler(thirdPartyEvaluations, "third_party_evaluations"),
  );

// ---- Exports ----

export const thirdPartyEvaluationsRoute = thirdPartyEvaluationsApp;
export type ThirdPartyEvaluationsRoute = typeof thirdPartyEvaluationsApp;
