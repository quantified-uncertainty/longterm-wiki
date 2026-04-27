/**
 * framework_capability_thresholds (QUA-691 Phase 4).
 *
 * Extracted capability thresholds per framework version. Dual risk_domain
 * columns: `risk_domain_canonical` (enum, for cross-lab matrix view) +
 * `risk_domain_label` (lab-native, for fidelity). `source_quote` is
 * MANDATORY — grounds every row in source evidence.
 */

import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { frameworkCapabilityThresholds } from "../../schema.js";
import {
  zv,
  clampedLimit,
  noDuplicateIds,
  notFoundError,
} from "../shared/utils.js";
import { paginatedQuery } from "../shared/paginated-query.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import {
  VALID_RISK_DOMAINS,
  VALID_COMMITMENT_LANGUAGES as VALID_COMMITMENT_LANG,
} from "../shared/framework-constants.js";
import { createSyncHandler } from "./sync-factory.js";

const MAX_PAGE_SIZE = 500;

const AllQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 200),
  offset: z.coerce.number().int().min(0).default(0),
  version_id: z.string().max(200).optional(),
  risk_domain_canonical: z.enum(VALID_RISK_DOMAINS).optional(),
  human_reviewed: z.coerce.boolean().optional(),
});

const SyncItemSchema = z.object({
  id: z.string().regex(
    /^[A-Za-z0-9_-]{10}$/,
    "id must be 10 alphanumeric characters (hyphens and underscores allowed)",
  ),
  versionId: z.string().min(1).max(200),
  riskDomainCanonical: z.enum(VALID_RISK_DOMAINS),
  riskDomainLabel: z.string().min(1).max(200),
  tierLabel: z.string().min(1).max(200),
  tierSortOrder: z.number().int().min(1).max(5),
  triggerDescription: z.string().min(1).max(5000),
  sourceQuote: z.string().min(1).max(5000),
  sourcePageHint: z.string().max(200).nullable().optional(),
  requiredMitigations: z.record(z.unknown()).nullable().optional(),
  associatedEvals: z.record(z.unknown()).nullable().optional(),
  commitmentLanguage: z.enum(VALID_COMMITMENT_LANG).nullable().optional(),
  extractedByModel: z.string().max(200).nullable().optional(),
  extractionConfidence: z.number().min(0).max(1).nullable().optional(),
  humanReviewed: z.boolean().optional(),
  humanReviewNotes: z.string().max(5000).nullable().optional(),
});

const SyncBatchSchema = z.object({
  items: z
    .array(SyncItemSchema)
    .min(1)
    .max(500)
    .refine(noDuplicateIds, { message: "Duplicate id values in items array" }),
});

const thresholdsApp = new Hono()

  .get("/stats", async (c) => {
    const db = getDrizzleDb();
    const [row] = await db
      .select({
        total: count(),
        versions: sql<number>`count(distinct ${frameworkCapabilityThresholds.versionId})`,
        reviewed: sql<number>`count(*) filter (where ${frameworkCapabilityThresholds.humanReviewed})`,
        canonicalDomains: sql<number>`count(distinct ${frameworkCapabilityThresholds.riskDomainCanonical})`,
      })
      .from(frameworkCapabilityThresholds);

    return c.json({
      total: row.total,
      versions: Number(row.versions),
      reviewed: Number(row.reviewed),
      canonicalDomains: Number(row.canonicalDomains),
    });
  })

  .get("/all", zv("query", AllQuery), async (c) => {
    const { limit, offset, version_id, risk_domain_canonical, human_reviewed } =
      c.req.valid("query");
    const db = getDrizzleDb();

    const conditions: SQL[] = [];
    if (version_id)
      conditions.push(eq(frameworkCapabilityThresholds.versionId, version_id));
    if (risk_domain_canonical)
      conditions.push(
        eq(frameworkCapabilityThresholds.riskDomainCanonical, risk_domain_canonical),
      );
    if (human_reviewed !== undefined)
      conditions.push(eq(frameworkCapabilityThresholds.humanReviewed, human_reviewed));

    const where =
      conditions.length === 0
        ? undefined
        : conditions.length === 1
          ? conditions[0]
          : and(...conditions);

    const { rows, total } = await paginatedQuery({
      query: db
        .select()
        .from(frameworkCapabilityThresholds)
        .where(where)
        .orderBy(
          frameworkCapabilityThresholds.versionId,
          frameworkCapabilityThresholds.tierSortOrder,
          frameworkCapabilityThresholds.riskDomainCanonical,
        )
        .limit(limit)
        .offset(offset),
      countQuery: db
        .select({ count: count() })
        .from(frameworkCapabilityThresholds)
        .where(where),
      formatRow: (r: typeof frameworkCapabilityThresholds.$inferSelect) => ({
        ...r,
        extractionConfidence:
          r.extractionConfidence == null ? null : Number(r.extractionConfidence),
      }),
    });

    return c.json({ items: rows, total, limit, offset });
  })

  .get("/by-version/:versionId", zv("query", AllQuery), async (c) => {
    const versionId = c.req.param("versionId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const where = eq(frameworkCapabilityThresholds.versionId, versionId);
    const { rows, total } = await paginatedQuery({
      query: db
        .select()
        .from(frameworkCapabilityThresholds)
        .where(where)
        .orderBy(
          frameworkCapabilityThresholds.tierSortOrder,
          frameworkCapabilityThresholds.riskDomainCanonical,
        )
        .limit(limit)
        .offset(offset),
      countQuery: db
        .select({ count: count() })
        .from(frameworkCapabilityThresholds)
        .where(where),
      formatRow: (r: typeof frameworkCapabilityThresholds.$inferSelect) => ({
        ...r,
        extractionConfidence:
          r.extractionConfidence == null ? null : Number(r.extractionConfidence),
      }),
    });

    return c.json({ versionId, items: rows, total, limit, offset });
  })

  .get("/by-entity/:entityId", zv("query", AllQuery), async (c) => {
    return c.json({
      entityId: c.req.param("entityId"),
      items: [],
      total: 0,
      limit: 0,
      offset: 0,
    });
  })

  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const db = getDrizzleDb();
    const rows = await db
      .select()
      .from(frameworkCapabilityThresholds)
      .where(eq(frameworkCapabilityThresholds.id, id))
      .limit(1);
    if (rows.length === 0) {
      return notFoundError(c, `Capability threshold ${id} not found`);
    }
    const r = rows[0];
    return c.json({
      ...r,
      extractionConfidence:
        r.extractionConfidence == null ? null : Number(r.extractionConfidence),
    });
  })

  .post(
    "/sync",
    createSyncHandler({
      name: "framework-capability-thresholds",
      table: frameworkCapabilityThresholds,
      batchSchema: SyncBatchSchema,
      toRow: (item, now) => ({
        ...item,
        extractionConfidence:
          item.extractionConfidence == null ? null : String(item.extractionConfidence),
        humanReviewed: item.humanReviewed ?? false,
        syncedAt: now,
        updatedAt: now,
      }),
      conflictSet: {
        versionId: sql`excluded.version_id`,
        riskDomainCanonical: sql`excluded.risk_domain_canonical`,
        riskDomainLabel: sql`excluded.risk_domain_label`,
        tierLabel: sql`excluded.tier_label`,
        tierSortOrder: sql`excluded.tier_sort_order`,
        triggerDescription: sql`excluded.trigger_description`,
        sourceQuote: sql`excluded.source_quote`,
        sourcePageHint: sql`COALESCE(excluded.source_page_hint, ${frameworkCapabilityThresholds.sourcePageHint})`,
        requiredMitigations: sql`COALESCE(excluded.required_mitigations, ${frameworkCapabilityThresholds.requiredMitigations})`,
        associatedEvals: sql`COALESCE(excluded.associated_evals, ${frameworkCapabilityThresholds.associatedEvals})`,
        commitmentLanguage: sql`COALESCE(excluded.commitment_language, ${frameworkCapabilityThresholds.commitmentLanguage})`,
        extractedByModel: sql`COALESCE(excluded.extracted_by_model, ${frameworkCapabilityThresholds.extractedByModel})`,
        extractionConfidence: sql`COALESCE(excluded.extraction_confidence, ${frameworkCapabilityThresholds.extractionConfidence})`,
        // NOTE: humanReviewed and humanReviewNotes use `excluded` directly —
        // the whole point of these columns is that a human review pass
        // should be able to flip reviewed:false → true by re-syncing.
        humanReviewed: sql`excluded.human_reviewed`,
        humanReviewNotes: sql`COALESCE(excluded.human_review_notes, ${frameworkCapabilityThresholds.humanReviewNotes})`,
        syncedAt: sql`now()`,
        updatedAt: sql`now()`,
      },
      auditRecordType: "framework_capability_thresholds",
      toThing: (item) => ({
        id: item.id,
        thingType: "framework-threshold" as const,
        parentThingId: item.versionId,
        sourceTable: "framework_capability_thresholds",
        sourceId: item.id,
      }),
    }),
  )

  .post("/delete-batch", deleteBatchHandler(frameworkCapabilityThresholds, "framework_capability_thresholds"));

export const frameworkCapabilityThresholdsRoute = thresholdsApp;
export type FrameworkCapabilityThresholdsRoute = typeof thresholdsApp;
