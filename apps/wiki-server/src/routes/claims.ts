import { Hono } from "hono";
import { z } from "zod";
import { eq, and, or, count, desc, asc, sql, inArray } from "drizzle-orm";
import { getDrizzleDb, getDb } from "../db.js";
import { claims, claimSources, claimPageReferences, entities, wikiPages } from "../schema.js";
import { checkRefsExist } from "./ref-check.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  notFoundError,
  firstOrThrow,
  paginationQuery,
} from "./utils.js";
import {
  InsertClaimSchema as SharedInsertClaimSchema,
  InsertClaimBatchSchema,
  ClearClaimsSchema,
  ClearClaimsBySectionSchema,
  ClaimPageReferenceInsertSchema,
  ClaimPageReferenceBatchSchema,
  type ClaimPageReferenceRow,
} from "../api-types.js";
import { TRIGRAM_SIMILARITY_THRESHOLD } from "../search-utils.js";
import { logger } from "../logger.js";
import { resolvePageIntId, resolvePageIntIds } from "./page-id-helpers.js";

/** Pre-computed schema for single page-reference insertion (omits claimId from URL param). */
const PageRefInsertBodySchema = ClaimPageReferenceInsertSchema.omit({ claimId: true });

// ---- Constants ----

const MAX_PAGE_SIZE = 1000;

// ---- Schemas (from shared api-types) ----

const InsertClaimSchema = SharedInsertClaimSchema;
const InsertBatchSchema = InsertClaimBatchSchema;

const PaginationQuery = paginationQuery({ maxLimit: MAX_PAGE_SIZE }).extend({
  entityType: z.string().max(100).optional(),
  claimType: z.string().max(100).optional(),
  claimCategory: z.string().max(100).optional(),
  claimMode: z.string().max(50).optional(),
  search: z.string().max(500).optional(),
  confidence: z.string().max(50).optional(), // @deprecated Use claimVerdict filter instead. Kept for backward compatibility.
  claimVerdict: z.string().max(50).optional(),
  entityId: z.string().max(200).optional(),
  attributedTo: z.string().max(300).optional(),
  measure: z.string().max(200).optional(),
  multiEntity: z.coerce.boolean().optional(),
  hasNumericValue: z.coerce.boolean().optional(),
  hasStructuredFields: z.coerce.boolean().optional(),
  subjectEntity: z.string().max(300).optional(),
  property: z.string().max(200).optional(),
  includeSources: z.coerce.boolean().optional(),
  sort: z
    .enum([
      "newest",
      "entity",
      "confidence",
      "as_of",
      "verdict",
      "verdict_score",
    ])
    .optional(),
  minVerdictScore: z.coerce.number().min(0).max(1).optional(),
  maxVerdictScore: z.coerce.number().min(0).max(1).optional(),
  verifiedOnly: z.coerce.boolean().optional(),
});

const DeleteByEntitySchema = ClearClaimsSchema;

// ---- Helpers ----

type ClaimInput = z.infer<typeof InsertClaimSchema>;

function claimValues(d: ClaimInput) {
  return {
    entityId: d.entityId,
    entityType: d.entityType,
    claimType: d.claimType,
    claimText: d.claimText,
    // @deprecated — legacy text fields; use valueNumeric/valueLow/valueHigh + measure instead
    value: d.value ?? null,
    unit: d.unit ?? null,
    confidence: d.confidence ?? null, // @deprecated Use claimVerdict instead. Kept for backward compatibility.
    sourceQuote: d.sourceQuote ?? null,
    // Enhanced fields (migration 0028)
    claimCategory: d.claimCategory ?? null,
    relatedEntities: d.relatedEntities ?? null,
    factId: d.factId ?? null,
    resourceIds: d.resourceIds ?? null,
    section: d.section ?? null,
    footnoteRefs: d.footnoteRefs ?? null,
    // Phase 2 fields (migration 0029)
    claimMode: d.claimMode ?? "endorsed",
    attributedTo: d.attributedTo ?? null,
    asOf: d.asOf ?? null,
    measure: d.measure ?? null,
    valueNumeric: d.valueNumeric ?? null,
    valueLow: d.valueLow ?? null,
    valueHigh: d.valueHigh ?? null,
    // Verdict fields (migration 0031)
    claimVerdict: d.claimVerdict ?? null,
    claimVerdictScore: d.claimVerdictScore ?? null,
    claimVerdictIssues: d.claimVerdictIssues ?? null,
    claimVerdictQuotes: d.claimVerdictQuotes ?? null,
    claimVerdictDifficulty: d.claimVerdictDifficulty ?? null,
    claimVerdictModel: d.claimVerdictModel ?? null,
    // Structured claim fields (migration 0032)
    subjectEntity: d.subjectEntity ?? null,
    property: d.property ?? null,
    structuredValue: d.structuredValue ?? null,
    valueUnit: d.valueUnit ?? null,
    valueDate: d.valueDate ?? null,
    qualifiers: d.qualifiers ?? null,
    // Reasoning traces (migration 0034)
    inferenceType: d.inferenceType ?? null,
  };
}

type ClaimSourceRowType = typeof claimSources.$inferSelect;

/** Pagination schema for the /quality endpoint. */
const QualityPaginationQuery = paginationQuery({ maxLimit: MAX_PAGE_SIZE, defaultLimit: 50 });

/** Row shape returned by the per-entity quality aggregation query. */
interface PerEntityQualityRow {
  entity_id: string;
  total_claims: number;
  verified_count: number;
  avg_verdict_score: number | null;
  min_verdict_score: number | null;
  max_verdict_score: number | null;
}

/** Row shape returned by the systemwide aggregates query. */
interface SystemwideRow {
  total_claims: number;
  total_verified: number;
  avg_score: number | null;
}

/** Row shape returned by the verdict distribution query. */
interface VerdictDistributionRow {
  verdict: string | null;
  cnt: number;
}

/** Row shape returned by the score bucket distribution query. */
interface ScoreBucketRow {
  bucket: string;
  cnt: number;
}

/** Raw row shape returned by the `/:id/similar` raw SQL query (pg_trgm similarity). */
interface SimilarClaimDbRow {
  id: number;
  entity_id: string;
  entity_type: string;
  claim_text: string;
  claim_category: string | null;
  confidence: number | null;
  similarity_score: string; // pg returns numeric as string
}

function formatClaimSource(s: ClaimSourceRowType) {
  return {
    id: Number(s.id),
    claimId: Number(s.claimId),
    resourceId: s.resourceId,
    url: s.url,
    sourceQuote: s.sourceQuote,
    isPrimary: s.isPrimary,
    addedAt: s.addedAt,
    sourceVerdict: s.sourceVerdict,
    sourceVerdictScore: s.sourceVerdictScore,
    sourceVerdictIssues: s.sourceVerdictIssues,
    sourceCheckedAt: s.sourceCheckedAt,
    sourceTitle: s.sourceTitle,
    sourceType: s.sourceType,
    sourceLocation: s.sourceLocation,
  };
}

/**
 * Normalize a relatedEntities array: lowercase all slugs and deduplicate.
 * This is the single source of truth for entity slug normalization in claims.
 * Frontend consumers receive already-normalized data and should NOT re-lowercase.
 */
function normalizeRelatedEntitiesSlugs(
  entities: unknown
): string[] | null {
  if (!Array.isArray(entities) || entities.length === 0) return null;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const e of entities) {
    if (typeof e !== "string") continue;
    const normalized = e.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result.length > 0 ? result : null;
}

function formatClaim(
  r: typeof claims.$inferSelect,
  sourcesRows: ClaimSourceRowType[] = []
) {
  return {
    id: Number(r.id),
    entityId: r.entityId,
    entityType: r.entityType,
    claimType: r.claimType,
    claimText: r.claimText,
    // @deprecated — legacy text fields; use valueNumeric/valueLow/valueHigh + measure instead
    value: r.value,
    unit: r.unit,
    confidence: r.confidence,
    sourceQuote: r.sourceQuote,
    // Enhanced fields (migration 0028)
    claimCategory: r.claimCategory,
    relatedEntities: normalizeRelatedEntitiesSlugs(r.relatedEntities),
    factId: r.factId,
    resourceIds: r.resourceIds as string[] | null,
    section: r.section,
    footnoteRefs: r.footnoteRefs,
    // Phase 2 fields (migration 0029)
    claimMode: r.claimMode,
    attributedTo: r.attributedTo,
    asOf: r.asOf,
    measure: r.measure,
    valueNumeric: r.valueNumeric,
    valueLow: r.valueLow,
    valueHigh: r.valueHigh,
    // Verdict fields (migration 0031)
    claimVerdict: r.claimVerdict,
    claimVerdictScore: r.claimVerdictScore,
    claimVerdictIssues: r.claimVerdictIssues,
    claimVerdictQuotes: r.claimVerdictQuotes,
    claimVerdictDifficulty: r.claimVerdictDifficulty,
    claimVerifiedAt: r.claimVerifiedAt,
    claimVerdictModel: r.claimVerdictModel,
    // Structured claim fields (migration 0032)
    subjectEntity: r.subjectEntity,
    property: r.property,
    structuredValue: r.structuredValue,
    valueUnit: r.valueUnit,
    valueDate: r.valueDate,
    qualifiers: r.qualifiers as Record<string, string> | null,
    // Reasoning traces (migration 0034)
    inferenceType: r.inferenceType,
    // Pinned claims (migration 0034)
    isPinned: r.isPinned,
    sources: sourcesRows.map(formatClaimSource),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ---- Schemas defined before the route (must be above method chain) ----

const DeleteByIdsSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(1000),
});

const AddClaimSourceSchema = z.object({
  resourceId: z.string().max(300).nullable().optional(),
  url: z.string().max(2000).nullable().optional(),
  sourceQuote: z.string().max(10000).nullable().optional(),
  isPrimary: z.boolean().optional(),
  sourceTitle: z.string().max(1000).nullable().optional(),
  sourceType: z.string().max(100).nullable().optional(),
  sourceLocation: z.string().max(1000).nullable().optional(),
  sourceVerdict: z.string().max(100).nullable().optional(),
  sourceVerdictScore: z.number().min(0).max(1).nullable().optional(),
  sourceCheckedAt: z.string().nullable().optional(),
});

const BatchUpdateRelatedEntitiesSchema = z.object({
  items: z.array(z.object({
    id: z.number().int().positive(),
    relatedEntities: z.array(z.string().max(300)).nullable(),
  })).min(1).max(500),
});

const BatchUpdateTextSchema = z.object({
  items: z.array(z.object({
    id: z.number().int().positive(),
    claimText: z.string().min(1).max(2000),
  })).min(1).max(500),
});

const BatchUpdateStructuredSchema = z.object({
  items: z.array(z.object({
    id: z.number().int().positive(),
    subjectEntity: z.string().max(300).nullable().optional(),
    property: z.string().max(200).nullable().optional(),
    structuredValue: z.string().max(2000).nullable().optional(),
    valueUnit: z.string().max(100).nullable().optional(),
    valueDate: z.string().max(20).nullable().optional(),
    qualifiers: z.record(z.string()).nullable().optional(),
  })).min(1).max(500),
});

const PatchClaimSchema = z.object({
  relatedEntities: z.array(z.string().max(300)).nullable().optional(),
  subjectEntity: z.string().max(300).nullable().optional(),
  property: z.string().max(200).nullable().optional(),
  structuredValue: z.string().max(2000).nullable().optional(),
  valueUnit: z.string().max(100).nullable().optional(),
  valueDate: z.string().max(20).nullable().optional(),
  qualifiers: z.record(z.string()).nullable().optional(),
  inferenceType: z.string().max(50).nullable().optional(),
  isPinned: z.boolean().optional(),
});

// ---- Route definition (method-chained for Hono RPC type inference) ----

const claimsApp = new Hono()
  // ---- POST / (insert single claim) ----
  .post("/", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = InsertClaimSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const db = getDrizzleDb();

    // Validate entity reference
    const missing = await checkRefsExist(db, entities, entities.id, [parsed.data.entityId]);
    if (missing.length > 0) {
      return validationError(c, `Referenced entity not found: ${missing.join(", ")}`);
    }

    const vals = claimValues(parsed.data);

    const rows = await db
      .insert(claims)
      .values(vals)
      .returning({
        id: claims.id,
        entityId: claims.entityId,
        claimType: claims.claimType,
      });

    const inserted = firstOrThrow(rows, "claim insert");

    // Insert claim_sources if provided
    if (parsed.data.sources && parsed.data.sources.length > 0) {
      const sourceVals = parsed.data.sources.map((s) => ({
        claimId: inserted.id,
        resourceId: s.resourceId ?? null,
        url: s.url ?? null,
        sourceQuote: s.sourceQuote ?? null,
        isPrimary: s.isPrimary ?? false,
        sourceTitle: s.sourceTitle ?? null,
        sourceType: s.sourceType ?? null,
        sourceLocation: s.sourceLocation ?? null,
        sourceVerdict: s.sourceVerdict ?? null,
        sourceVerdictScore: s.sourceVerdictScore ?? null,
        sourceCheckedAt: s.sourceCheckedAt ? new Date(s.sourceCheckedAt) : null,
      }));
      await db.insert(claimSources).values(sourceVals);
    }

    return c.json(inserted, 201);
  })
  // ---- POST /batch (insert multiple claims) ----
  .post("/batch", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = InsertBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;
    const db = getDrizzleDb();

    // Validate entity references
    const entityIds = [...new Set(items.map((i) => i.entityId))];
    const missing = await checkRefsExist(db, entities, entities.id, entityIds);
    if (missing.length > 0) {
      return validationError(c, `Referenced entities not found: ${missing.join(", ")}`);
    }

    const itemsWithSources = items.filter(
      (item) => item.sources && item.sources.length > 0
    );

    // PostgreSQL's RETURNING clause does not guarantee row ordering matches
    // insertion order, so we cannot safely correlate results[i] with items[i]
    // when sources need to be attached to specific claims.
    //
    // Strategy: if no item has sources, use a fast multi-row batch insert.
    // If any item has sources, insert one-at-a-time so each claim's ID is known.
    const allResults: Array<{ id: number; entityId: string; claimType: string }> = [];

    if (itemsWithSources.length === 0) {
      // Fast path: bulk insert, no source correlation needed
      const allVals = items.map(claimValues);
      const rows = await db
        .insert(claims)
        .values(allVals)
        .returning({ id: claims.id, entityId: claims.entityId, claimType: claims.claimType });
      allResults.push(...rows);
    } else {
      // Safe path: insert one at a time to guarantee ID correlation for source rows.
      // Wrapped in a transaction for atomicity and reduced connection hold time.
      await db.transaction(async (tx) => {
        const sourcesToInsert: Array<{
          claimId: number;
          resourceId: string | null;
          url: string | null;
          sourceQuote: string | null;
          isPrimary: boolean;
          sourceTitle: string | null;
          sourceType: string | null;
          sourceLocation: string | null;
          sourceVerdict: string | null;
          sourceVerdictScore: number | null;
          sourceCheckedAt: Date | null;
        }> = [];

        for (const item of items) {
          const [row] = await tx
            .insert(claims)
            .values(claimValues(item))
            .returning({ id: claims.id, entityId: claims.entityId, claimType: claims.claimType });

          allResults.push(row);

          if (item.sources && item.sources.length > 0) {
            for (const s of item.sources) {
              sourcesToInsert.push({
                claimId: row.id,
                resourceId: s.resourceId ?? null,
                url: s.url ?? null,
                sourceQuote: s.sourceQuote ?? null,
                isPrimary: s.isPrimary ?? false,
                sourceTitle: s.sourceTitle ?? null,
                sourceType: s.sourceType ?? null,
                sourceLocation: s.sourceLocation ?? null,
                sourceVerdict: s.sourceVerdict ?? null,
                sourceVerdictScore: s.sourceVerdictScore ?? null,
                sourceCheckedAt: s.sourceCheckedAt ? new Date(s.sourceCheckedAt) : null,
              });
            }
          }
        }

        if (sourcesToInsert.length > 0) {
          await tx.insert(claimSources).values(sourcesToInsert);
        }
      });
    }

    return c.json({ inserted: allResults.length, results: allResults }, 201);
  })
  // ---- POST /clear (delete all claims for an entity) ----
  // NOTE: This deletes claims where `entityId` matches (primary entity only).
  // Claims where the entity appears in `relatedEntities` are NOT deleted.
  // This is intentional — relatedEntities are secondary references owned by
  // the primary entity's extraction, and should only be removed when that
  // primary entity's claims are cleared.
  .post("/clear", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = DeleteByEntitySchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const db = getDrizzleDb();
    const deleted = await db
      .delete(claims)
      .where(eq(claims.entityId, parsed.data.entityId))
      .returning({ id: claims.id });

    return c.json({ deleted: deleted.length });
  })
  // ---- POST /clear-by-section (delete only claims matching entity+section) ----
  // Used by resource ingestion --force to re-ingest a single resource without
  // clobbering claims from page extraction or other resources.
  .post("/clear-by-section", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = ClearClaimsBySectionSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const db = getDrizzleDb();
    const deleted = await db
      .delete(claims)
      .where(
        and(
          eq(claims.entityId, parsed.data.entityId),
          eq(claims.section, parsed.data.section)
        )
      )
      .returning({ id: claims.id });

    return c.json({ deleted: deleted.length });
  })
  // ---- POST /delete-by-ids (batch delete claims by ID array) ----
  // Used by the cleanup command to remove low-quality claims in bulk.
  .post("/delete-by-ids", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = DeleteByIdsSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    // Audit log: record bulk deletion before executing it
    logger.info({
      audit: "bulk-claim-delete",
      count: parsed.data.ids.length,
      claimIds: parsed.data.ids,
    }, "Bulk claim delete");

    const db = getDrizzleDb();
    const deleted = await db
      .delete(claims)
      .where(inArray(claims.id, parsed.data.ids))
      .returning({ id: claims.id });

    return c.json({ deleted: deleted.length });
  })
  // ---- GET /stats ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const totalResult = await db.select({ count: count() }).from(claims);
    const total = totalResult[0].count;

    const byType = await db
      .select({ claimType: claims.claimType, count: count() })
      .from(claims)
      .groupBy(claims.claimType)
      .orderBy(desc(count()));

    const byEntityType = await db
      .select({ entityType: claims.entityType, count: count() })
      .from(claims)
      .groupBy(claims.entityType)
      .orderBy(desc(count()));

    const byCategory = await db
      .select({ claimCategory: claims.claimCategory, count: count() })
      .from(claims)
      .groupBy(claims.claimCategory)
      .orderBy(desc(count()));

    const byMode = await db
      .select({ claimMode: claims.claimMode, count: count() })
      .from(claims)
      .groupBy(claims.claimMode)
      .orderBy(desc(count()));

    // Multi-entity claims
    const multiEntityResult = await db
      .select({ count: count() })
      .from(claims)
      .where(sql`${claims.relatedEntities} IS NOT NULL AND jsonb_array_length(${claims.relatedEntities}) > 0`);

    // Fact-linked claims
    const factLinkedResult = await db
      .select({ count: count() })
      .from(claims)
      .where(sql`${claims.factId} IS NOT NULL`);

    // Claims with claim_sources entries
    const withSourcesResult = await db
      .select({ count: count() })
      .from(claims)
      .where(
        sql`EXISTS (SELECT 1 FROM claim_sources cs WHERE cs.claim_id = ${claims.id})`
      );

    // Attributed claims
    const attributedResult = await db
      .select({ count: count() })
      .from(claims)
      .where(eq(claims.claimMode, "attributed"));

    // Claims with numeric value (central, low, or high)
    const numericResult = await db
      .select({ count: count() })
      .from(claims)
      .where(
        sql`${claims.valueNumeric} IS NOT NULL OR ${claims.valueLow} IS NOT NULL OR ${claims.valueHigh} IS NOT NULL`
      );

    // Structured claims (with property set)
    const structuredResult = await db
      .select({ count: count() })
      .from(claims)
      .where(sql`${claims.property} IS NOT NULL`);

    // Property distribution (for structured claims)
    const byProperty = await db
      .select({ property: claims.property, count: count() })
      .from(claims)
      .where(sql`${claims.property} IS NOT NULL`)
      .groupBy(claims.property)
      .orderBy(desc(count()));

    // Verdict distribution
    const byVerdict = await db
      .select({ claimVerdict: claims.claimVerdict, count: count() })
      .from(claims)
      .groupBy(claims.claimVerdict)
      .orderBy(desc(count()));

    return c.json({
      total,
      byClaimType: Object.fromEntries(byType.map((r) => [r.claimType, r.count])),
      byEntityType: Object.fromEntries(byEntityType.map((r) => [r.entityType, r.count])),
      byClaimCategory: Object.fromEntries(
        byCategory.map((r) => [r.claimCategory ?? "uncategorized", r.count])
      ),
      byClaimMode: Object.fromEntries(
        byMode.map((r) => [r.claimMode ?? "uncategorized", r.count])
      ),
      byClaimVerdict: Object.fromEntries(
        byVerdict.map((r) => [r.claimVerdict ?? "unverified", r.count])
      ),
      multiEntityClaims: multiEntityResult[0].count,
      factLinkedClaims: factLinkedResult[0].count,
      withSourcesClaims: withSourcesResult[0].count,
      attributedClaims: attributedResult[0].count,
      numericClaims: numericResult[0].count,
      structuredClaims: structuredResult[0].count,
      byProperty: Object.fromEntries(
        byProperty.map((r) => [r.property ?? "unknown", r.count])
      ),
    });
  })
  // ---- GET /by-entity/:entityId (claims for a specific entity) ----
  // Returns claims where entityId matches OR the entity appears in relatedEntities.
  .get("/by-entity/:entityId", async (c) => {
    const entityId = c.req.param("entityId");
    const includeSources = c.req.query("includeSources") === "true";
    const db = getDrizzleDb();

    // Query: primary entity match OR entity appears in the relatedEntities JSONB array
    const rows = await db
      .select()
      .from(claims)
      .where(
        or(
          eq(claims.entityId, entityId),
          sql`${claims.relatedEntities} @> ${JSON.stringify([entityId])}::jsonb`
        )
      )
      .orderBy(asc(claims.claimType), asc(claims.id));

    let sourcesMap = new Map<number, typeof claimSources.$inferSelect[]>();
    if (includeSources && rows.length > 0) {
      const claimIds = rows.map((r) => r.id);
      const sourcesRows = await db
        .select()
        .from(claimSources)
        .where(inArray(claimSources.claimId, claimIds));
      for (const s of sourcesRows) {
        const id = Number(s.claimId);
        if (!sourcesMap.has(id)) sourcesMap.set(id, []);
        sourcesMap.get(id)!.push(s);
      }
    }

    const includePageReferences = c.req.query("includePageReferences") === "true";

    type PageRefWithSlug = {
      id: typeof claimPageReferences.$inferSelect["id"];
      claimId: typeof claimPageReferences.$inferSelect["claimId"];
      pageSlug: string | null;
      footnote: typeof claimPageReferences.$inferSelect["footnote"];
      section: typeof claimPageReferences.$inferSelect["section"];
      quoteText: typeof claimPageReferences.$inferSelect["quoteText"];
      referenceId: typeof claimPageReferences.$inferSelect["referenceId"];
      createdAt: typeof claimPageReferences.$inferSelect["createdAt"];
    };
    let pageRefsMap = new Map<number, PageRefWithSlug[]>();
    if (includePageReferences && rows.length > 0) {
      const claimIds = rows.map((r) => r.id);
      // Phase D2b: page_id_old dropped; join wiki_pages to get slug via page_id_int
      const pageRefRows = await db
        .select({
          id: claimPageReferences.id,
          claimId: claimPageReferences.claimId,
          pageSlug: wikiPages.id,
          footnote: claimPageReferences.footnote,
          section: claimPageReferences.section,
          quoteText: claimPageReferences.quoteText,
          referenceId: claimPageReferences.referenceId,
          createdAt: claimPageReferences.createdAt,
        })
        .from(claimPageReferences)
        .leftJoin(wikiPages, eq(claimPageReferences.pageIdInt, wikiPages.integerIdCol))
        .where(inArray(claimPageReferences.claimId, claimIds));
      for (const pr of pageRefRows) {
        const cid = Number(pr.claimId);
        if (!pageRefsMap.has(cid)) pageRefsMap.set(cid, []);
        pageRefsMap.get(cid)!.push(pr);
      }
    }

    return c.json({
      claims: rows.map((r) => {
        const claim: ReturnType<typeof formatClaim> & { pageReferences?: ClaimPageReferenceRow[] } =
          formatClaim(r, sourcesMap.get(Number(r.id)) ?? []);
        if (includePageReferences) {
          claim.pageReferences = (pageRefsMap.get(Number(r.id)) ?? [])
            .filter((pr) => pr.pageSlug != null)
            .map((pr) => ({
              id: Number(pr.id),
              claimId: Number(pr.claimId),
              pageId: pr.pageSlug!,
              footnote: pr.footnote,
              section: pr.section,
              quoteText: pr.quoteText,
              referenceId: pr.referenceId,
              createdAt: pr.createdAt?.toISOString() ?? new Date().toISOString(),
            }));
        }
        return claim;
      }),
    });
  })
  // ---- GET /all (paginated listing) ----
  .get("/all", async (c) => {
    const parsed = PaginationQuery.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.message);

    const {
      limit, offset, entityType, claimType, claimCategory, claimMode,
      search, confidence, claimVerdict, entityId, attributedTo, measure,
      multiEntity, hasNumericValue, hasStructuredFields,
      subjectEntity, property,
      includeSources,
      sort,
      minVerdictScore,
      maxVerdictScore,
      verifiedOnly,
    } = parsed.data;
    const db = getDrizzleDb();

    const conditions = [];
    if (entityType) conditions.push(eq(claims.entityType, entityType));
    if (claimType) conditions.push(eq(claims.claimType, claimType));
    if (claimCategory)
      conditions.push(eq(claims.claimCategory, claimCategory));
    if (claimMode) conditions.push(eq(claims.claimMode, claimMode));
    if (search)
      conditions.push(
        sql`${claims.claimText} ILIKE ${"%" + search + "%"}`
      );
    if (confidence)
      conditions.push(eq(claims.confidence, confidence)); // @deprecated
    if (claimVerdict)
      conditions.push(eq(claims.claimVerdict, claimVerdict));
    if (entityId) conditions.push(eq(claims.entityId, entityId));
    if (attributedTo)
      conditions.push(eq(claims.attributedTo, attributedTo));
    if (measure) conditions.push(eq(claims.measure, measure));
    if (multiEntity) {
      conditions.push(
        sql`${claims.relatedEntities} IS NOT NULL AND jsonb_array_length(${claims.relatedEntities}) > 0`
      );
    }
    if (hasNumericValue) {
      conditions.push(sql`${claims.valueNumeric} IS NOT NULL`);
    }
    if (hasStructuredFields) {
      conditions.push(sql`${claims.property} IS NOT NULL`);
    }
    if (subjectEntity)
      conditions.push(eq(claims.subjectEntity, subjectEntity));
    if (property) conditions.push(eq(claims.property, property));
    if (minVerdictScore != null) {
      conditions.push(
        sql`${claims.claimVerdictScore} >= ${minVerdictScore}`
      );
    }
    if (maxVerdictScore != null) {
      conditions.push(
        sql`${claims.claimVerdictScore} <= ${maxVerdictScore}`
      );
    }
    if (verifiedOnly) {
      conditions.push(sql`${claims.claimVerdict} IS NOT NULL`);
    }

    const whereClause =
      conditions.length > 0
        ? conditions.length === 1
          ? conditions[0]
          : and(...conditions)
        : undefined;

    const orderBy =
      sort === "newest"
        ? desc(claims.id)
        : sort === "entity"
          ? asc(claims.entityId)
          : sort === "confidence"
            ? asc(claims.confidence)
            : sort === "verdict"
              ? asc(claims.claimVerdict)
              : sort === "verdict_score"
                ? desc(claims.claimVerdictScore)
                : sort === "as_of"
                  ? desc(claims.asOf)
                  : asc(claims.id);

    const rows = await db
      .select()
      .from(claims)
      .where(whereClause)
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(claims)
      .where(whereClause);
    const total = countResult[0].count;

    let sourcesMap = new Map<number, typeof claimSources.$inferSelect[]>();
    if (includeSources && rows.length > 0) {
      const claimIds = rows.map((r) => r.id);
      const sourcesRows = await db
        .select()
        .from(claimSources)
        .where(inArray(claimSources.claimId, claimIds));
      for (const s of sourcesRows) {
        const id = Number(s.claimId);
        if (!sourcesMap.has(id)) sourcesMap.set(id, []);
        sourcesMap.get(id)!.push(s);
      }
    }

    return c.json({
      claims: rows.map((r) => formatClaim(r, sourcesMap.get(Number(r.id)) ?? [])),
      total,
      limit,
      offset,
    });
  })
  // ---- GET /relationships (entity-pair relationships) ----
  .get("/relationships", async (c) => {
    const db = getDrizzleDb();
    const rows = await db
      .select()
      .from(claims)
      .where(
        sql`${claims.relatedEntities} IS NOT NULL AND jsonb_array_length(${claims.relatedEntities}) > 0`
      );

    const pairMap = new Map<
      string,
      { entityA: string; entityB: string; claimCount: number; sampleClaims: string[] }
    >();

    for (const row of rows) {
      const related = normalizeRelatedEntitiesSlugs(row.relatedEntities);
      if (!related) continue;
      for (const normalizedRel of related) {
        // Skip self-referential pairs
        if (normalizedRel === row.entityId) continue;
        const [a, b] = [row.entityId, normalizedRel].sort();
        const key = `${a}|||${b}`;
        if (!pairMap.has(key)) {
          pairMap.set(key, { entityA: a, entityB: b, claimCount: 0, sampleClaims: [] });
        }
        const entry = pairMap.get(key)!;
        entry.claimCount++;
        if (entry.sampleClaims.length < 3) {
          entry.sampleClaims.push(row.claimText.slice(0, 150));
        }
      }
    }

    const relationships = [...pairMap.values()].sort((a, b) => b.claimCount - a.claimCount);
    return c.json({ relationships });
  })
  // ---- GET /network (graph-ready node/edge data) ----
  .get("/network", async (c) => {
    const db = getDrizzleDb();

    const entityCounts = await db
      .select({ entityId: claims.entityId, count: count() })
      .from(claims)
      .groupBy(claims.entityId);

    const rows = await db
      .select()
      .from(claims)
      .where(
        sql`${claims.relatedEntities} IS NOT NULL AND jsonb_array_length(${claims.relatedEntities}) > 0`
      );

    const edgeMap = new Map<string, { source: string; target: string; weight: number }>();
    const nodeIds = new Set<string>();
    const mentionCounts = new Map<string, number>();

    for (const row of rows) {
      nodeIds.add(row.entityId);
      const related = normalizeRelatedEntitiesSlugs(row.relatedEntities);
      if (!related) continue;
      for (const normalizedRel of related) {
        // Skip self-loops
        if (normalizedRel === row.entityId) continue;
        nodeIds.add(normalizedRel);
        mentionCounts.set(normalizedRel, (mentionCounts.get(normalizedRel) ?? 0) + 1);
        const [source, target] = [row.entityId, normalizedRel].sort();
        const key = `${source}|||${target}`;
        if (!edgeMap.has(key)) {
          edgeMap.set(key, { source, target, weight: 0 });
        }
        edgeMap.get(key)!.weight++;
      }
    }

    const countMap = Object.fromEntries(
      entityCounts.map((r) => [r.entityId, r.count])
    );
    const nodes = [...nodeIds].map((id) => ({
      entityId: id,
      claimCount: countMap[id] ?? 0,
      mentionCount: mentionCounts.get(id) ?? 0,
    }));
    const edges = [...edgeMap.values()].sort((a, b) => b.weight - a.weight);

    return c.json({ nodes, edges });
  })
  // ---- GET /pinned/:entityId (pinned claims for an entity) ----
  // Returns claims where isPinned=true and subjectEntity matches.
  // Used by <F> components to read canonical structured values.
  .get("/pinned/:entityId", async (c) => {
    const entityId = c.req.param("entityId");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(claims)
      .where(
        and(
          eq(claims.isPinned, true),
          eq(claims.subjectEntity, entityId)
        )
      )
      .orderBy(asc(claims.property));

    // Include sources for pinned claims
    let sourcesMap = new Map<number, typeof claimSources.$inferSelect[]>();
    if (rows.length > 0) {
      const claimIds = rows.map((r) => r.id);
      const sourcesRows = await db
        .select()
        .from(claimSources)
        .where(inArray(claimSources.claimId, claimIds));
      for (const s of sourcesRows) {
        const id = Number(s.claimId);
        if (!sourcesMap.has(id)) sourcesMap.set(id, []);
        sourcesMap.get(id)!.push(s);
      }
    }

    return c.json({
      claims: rows.map((r) => formatClaim(r, sourcesMap.get(Number(r.id)) ?? [])),
    });
  })
  // ---- GET /:id/similar (find similar claims via pg_trgm) ----
  .get("/:id/similar", async (c) => {
    const idStr = c.req.param("id");
    const id = Number(idStr);
    if (!Number.isInteger(id) || id <= 0) {
      return validationError(c, "Claim ID must be a positive integer");
    }

    const limitParam = c.req.query("limit");
    const limit = Math.min(Math.max(Number(limitParam) || 5, 1), 20);

    const db = getDrizzleDb();

    // Fetch the target claim's text
    const targetRows = await db
      .select({ claimText: claims.claimText })
      .from(claims)
      .where(eq(claims.id, id))
      .limit(1);

    if (targetRows.length === 0) {
      return notFoundError(c, `Claim not found: ${id}`);
    }

    const targetText = targetRows[0].claimText;

    // Use raw SQL for the similarity() function (same pattern as pages.ts trigram fallback)
    const rawDb = getDb();
    const rows = await rawDb.unsafe<SimilarClaimDbRow[]>(
      `SELECT
      id, entity_id, entity_type, claim_text, claim_category, confidence,
      similarity(claim_text, $1) AS similarity_score
    FROM claims
    WHERE id != $2
      AND similarity(claim_text, $1) > ${TRIGRAM_SIMILARITY_THRESHOLD}
    ORDER BY similarity(claim_text, $1) DESC
    LIMIT $3`,
      [targetText, id, limit],
    );

    return c.json({
      claims: rows.map((r) => ({
        id: Number(r.id),
        entityId: r.entity_id,
        entityType: r.entity_type,
        claimText: r.claim_text,
        claimCategory: r.claim_category,
        confidence: r.confidence,
        similarityScore: parseFloat(r.similarity_score) || 0,
      })),
    });
  })
  // ---- GET /:id/sources (sources for a specific claim) ----
  .get("/:id/sources", async (c) => {
    const idStr = c.req.param("id");
    const id = Number(idStr);
    if (!Number.isInteger(id) || id <= 0) {
      return validationError(c, "Claim ID must be a positive integer");
    }

    const db = getDrizzleDb();
    const rows = await db
      .select()
      .from(claimSources)
      .where(eq(claimSources.claimId, id))
      .orderBy(desc(claimSources.isPrimary), asc(claimSources.addedAt));

    return c.json({ sources: rows.map(formatClaimSource) });
  })
  // ---- POST /:id/sources (add a source to a claim) ----
  .post("/:id/sources", async (c) => {
    const idStr = c.req.param("id");
    const id = Number(idStr);
    if (!Number.isInteger(id) || id <= 0) {
      return validationError(c, "Claim ID must be a positive integer");
    }

    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = AddClaimSourceSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const db = getDrizzleDb();

    // Verify claim exists
    const claimRows = await db
      .select({ id: claims.id })
      .from(claims)
      .where(eq(claims.id, id))
      .limit(1);

    if (claimRows.length === 0) {
      return notFoundError(c, `Claim not found: ${id}`);
    }

    const rows = await db
      .insert(claimSources)
      .values({
        claimId: id,
        resourceId: parsed.data.resourceId ?? null,
        url: parsed.data.url ?? null,
        sourceQuote: parsed.data.sourceQuote ?? null,
        isPrimary: parsed.data.isPrimary ?? false,
        sourceTitle: parsed.data.sourceTitle ?? null,
        sourceType: parsed.data.sourceType ?? null,
        sourceLocation: parsed.data.sourceLocation ?? null,
        sourceVerdict: parsed.data.sourceVerdict ?? null,
        sourceVerdictScore: parsed.data.sourceVerdictScore ?? null,
        sourceCheckedAt: parsed.data.sourceCheckedAt ? new Date(parsed.data.sourceCheckedAt) : null,
      })
      .returning();

    return c.json(formatClaimSource(firstOrThrow(rows, "claim_source insert")), 201);
  })
  // ---- PATCH /batch-update-related-entities (bulk update relatedEntities) ----
  // Accepts an array of {id, relatedEntities} pairs and updates them all.
  // IMPORTANT: Must be defined before PATCH /:id to avoid wildcard matching.
  .patch("/batch-update-related-entities", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = BatchUpdateRelatedEntitiesSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const db = getDrizzleDb();
    const now = new Date();

    const updated = await db.transaction(async (tx) => {
      let count = 0;
      for (const item of parsed.data.items) {
        const result = await tx
          .update(claims)
          .set({ relatedEntities: item.relatedEntities, updatedAt: now })
          .where(eq(claims.id, item.id))
          .returning({ id: claims.id });
        if (result.length > 0) count++;
      }
      return count;
    });

    return c.json({ updated, total: parsed.data.items.length });
  })
  // ---- PATCH /batch-update-text (bulk update claimText) ----
  // Used by `crux claims fix strip-markup` and `crux claims fix self-contain`.
  // IMPORTANT: Must be defined before PATCH /:id to avoid wildcard matching.
  .patch("/batch-update-text", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = BatchUpdateTextSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const db = getDrizzleDb();
    const now = new Date();
    let updated = 0;

    for (const item of parsed.data.items) {
      const result = await db
        .update(claims)
        .set({ claimText: item.claimText, updatedAt: now })
        .where(eq(claims.id, item.id))
        .returning({ id: claims.id });
      if (result.length > 0) updated++;
    }

    return c.json({ updated, total: parsed.data.items.length });
  })
  // ---- PATCH /batch-update-structured (bulk update structured fields) ----
  // Accepts an array of {id, subjectEntity, property, ...} pairs.
  // IMPORTANT: Must be defined before PATCH /:id to avoid wildcard matching.
  .patch("/batch-update-structured", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = BatchUpdateStructuredSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const db = getDrizzleDb();
    const now = new Date();

    const updated = await db.transaction(async (tx) => {
      let count = 0;
      for (const item of parsed.data.items) {
        const updates: Record<string, unknown> = { updatedAt: now };
        if (item.subjectEntity !== undefined) updates.subjectEntity = item.subjectEntity;
        if (item.property !== undefined) updates.property = item.property;
        if (item.structuredValue !== undefined) updates.structuredValue = item.structuredValue;
        if (item.valueUnit !== undefined) updates.valueUnit = item.valueUnit;
        if (item.valueDate !== undefined) updates.valueDate = item.valueDate;
        if (item.qualifiers !== undefined) updates.qualifiers = item.qualifiers;

        const result = await tx
          .update(claims)
          .set(updates)
          .where(eq(claims.id, item.id))
          .returning({ id: claims.id });
        if (result.length > 0) count++;
      }
      return count;
    });

    return c.json({ updated, total: parsed.data.items.length });
  })
  // ---- PATCH /:id (partial update) ----
  // Supports updating relatedEntities and structured fields.
  .patch("/:id", async (c) => {
    const idStr = c.req.param("id");
    const id = Number(idStr);
    if (!Number.isInteger(id) || id <= 0) {
      return validationError(c, "Claim ID must be a positive integer");
    }

    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = PatchClaimSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const db = getDrizzleDb();

    // Verify claim exists
    const existing = await db
     .select({ id: claims.id })
      .from(claims)
      .where(eq(claims.id, id))
      .limit(1);

    if (existing.length === 0) {
      return notFoundError(c, `Claim not found: ${id}`);
    }

    // Build update set — only include fields that were provided
    const updates: Record<string, unknown> = {};
    if (parsed.data.relatedEntities !== undefined) {
      updates.relatedEntities = parsed.data.relatedEntities;
    }
    if (parsed.data.subjectEntity !== undefined) updates.subjectEntity = parsed.data.subjectEntity;
    if (parsed.data.property !== undefined) updates.property = parsed.data.property;
    if (parsed.data.structuredValue !== undefined) updates.structuredValue = parsed.data.structuredValue;
    if (parsed.data.valueUnit !== undefined) updates.valueUnit = parsed.data.valueUnit;
    if (parsed.data.valueDate !== undefined) updates.valueDate = parsed.data.valueDate;
    if (parsed.data.qualifiers !== undefined) updates.qualifiers = parsed.data.qualifiers;
    if (parsed.data.inferenceType !== undefined) updates.inferenceType = parsed.data.inferenceType;
    if (parsed.data.isPinned !== undefined) {
      updates.isPinned = parsed.data.isPinned;
      // When pinning, unpin any other claim with the same subject+property
      if (parsed.data.isPinned === true) {
        const claimRow = await db
          .select({ subjectEntity: claims.subjectEntity, property: claims.property })
          .from(claims)
          .where(eq(claims.id, id))
          .limit(1);
        const claim = claimRow[0];
        if (claim?.subjectEntity && claim?.property) {
          await db
            .update(claims)
            .set({ isPinned: false, updatedAt: new Date() })
            .where(
              and(
                eq(claims.subjectEntity, claim.subjectEntity),
                eq(claims.property, claim.property),
                eq(claims.isPinned, true),
                sql`${claims.id} != ${id}`
              )
            );
        }
      }
    }

    if (Object.keys(updates).length === 0) {
      return validationError(c, "No fields to update");
    }

    updates.updatedAt = new Date();

    const rows = await db
      .update(claims)
      .set(updates)
      .where(eq(claims.id, id))
      .returning();

    const sourcesRows = await db
      .select()
      .from(claimSources)
      .where(eq(claimSources.claimId, id))
      .orderBy(desc(claimSources.isPrimary), asc(claimSources.addedAt));

    const row = firstOrThrow(rows, "claim update");
    return c.json(formatClaim(row, sourcesRows));
  })
  // ---- GET /quality (aggregate quality metrics per entity and system-wide) ----
  // Supports pagination via limit/offset query params (default: limit=50, offset=0).
  // IMPORTANT: Must be defined before GET /:id to avoid wildcard matching.
  .get("/quality", async (c) => {
    const parsed = QualityPaginationQuery.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.message);
    const { limit, offset } = parsed.data;

    const rawDb = getDb();

    // Run all queries in parallel — consolidates 5 sequential queries into 1 parallel batch.
    const [perEntityRows, entityCountResult, systemwideResult, verdictRows, bucketRows] = await Promise.all([
      // 1. Paginated per-entity quality metrics
      rawDb.unsafe<PerEntityQualityRow[]>(
        `SELECT
           entity_id,
           count(*)::int AS total_claims,
           count(*) FILTER (WHERE claim_verdict IS NOT NULL)::int AS verified_count,
           avg(claim_verdict_score) AS avg_verdict_score,
           min(claim_verdict_score) AS min_verdict_score,
           max(claim_verdict_score) AS max_verdict_score
         FROM claims
         GROUP BY entity_id
         ORDER BY count(*) DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      // 2. Total number of distinct entities (for pagination metadata)
      rawDb.unsafe<[{ cnt: string }]>(
        `SELECT count(DISTINCT entity_id)::int AS cnt FROM claims`,
      ),
      // 3. Systemwide aggregates: totals, verified count, avg score
      rawDb.unsafe<SystemwideRow[]>(
        `SELECT
           (SELECT count(*)::int FROM claims) AS total_claims,
           (SELECT count(*)::int FROM claims WHERE claim_verdict IS NOT NULL) AS total_verified,
           (SELECT avg(claim_verdict_score) FROM claims WHERE claim_verdict_score IS NOT NULL) AS avg_score`,
      ),
      // 4. Verdict distribution
      rawDb.unsafe<VerdictDistributionRow[]>(
        `SELECT claim_verdict AS verdict, count(*)::int AS cnt
         FROM claims
         GROUP BY claim_verdict
         ORDER BY cnt DESC`,
      ),
      // 5. Score distribution buckets
      rawDb.unsafe<ScoreBucketRow[]>(
        `SELECT
           CASE
             WHEN claim_verdict_score < 0.2 THEN '0-20'
             WHEN claim_verdict_score < 0.4 THEN '20-40'
             WHEN claim_verdict_score < 0.6 THEN '40-60'
             WHEN claim_verdict_score < 0.8 THEN '60-80'
             ELSE '80-100'
           END AS bucket,
           count(*)::int AS cnt
         FROM claims
         WHERE claim_verdict_score IS NOT NULL
         GROUP BY bucket`,
      ),
    ]);

    const totalEntities = Number(entityCountResult[0]?.cnt ?? 0);

    const entityQuality = perEntityRows.map((r) => ({
      entityId: r.entity_id,
      totalClaims: Number(r.total_claims),
      verifiedCount: Number(r.verified_count),
      verifiedPct:
        Number(r.total_claims) > 0
          ? Math.round(
              (Number(r.verified_count) / Number(r.total_claims)) * 100
            )
          : 0,
      avgVerdictScore:
        r.avg_verdict_score != null
          ? Math.round(Number(r.avg_verdict_score) * 100) / 100
          : null,
      minVerdictScore:
        r.min_verdict_score != null
          ? Math.round(Number(r.min_verdict_score) * 100) / 100
          : null,
      maxVerdictScore:
        r.max_verdict_score != null
          ? Math.round(Number(r.max_verdict_score) * 100) / 100
          : null,
    }));

    // Parse systemwide aggregates from the consolidated query
    const sw = systemwideResult[0];
    const total = Number(sw?.total_claims ?? 0);
    const totalVerified = Number(sw?.total_verified ?? 0);
    const avgScore = sw?.avg_score != null ? Number(sw.avg_score) : null;

    return c.json({
      entities: entityQuality,
      pagination: {
        limit,
        offset,
        total: totalEntities,
        totalPages: Math.ceil(totalEntities / limit),
      },
      systemwide: {
        totalClaims: total,
        totalVerified,
        verifiedPct:
          total > 0
            ? Math.round((totalVerified / total) * 100)
            : 0,
        avgVerdictScore:
          avgScore != null
            ? Math.round(avgScore * 100) / 100
            : null,
        byVerdict: Object.fromEntries(
          verdictRows.map((r) => [
            r.verdict ?? "unverified",
            Number(r.cnt),
          ])
        ),
        scoreBuckets: Object.fromEntries(
          bucketRows.map((r) => [r.bucket, Number(r.cnt)])
        ),
      },
    });
  })

  // ---- GET /by-page — claims for a specific wiki page, grouped by footnote ----
  // Replaces the deprecated GET /api/citations/quotes endpoint (#1311).
  // Joins claims → claim_page_references (for footnote) → claim_sources (for source data).
  // Returns a CitationQuote-compatible shape for the frontend CitationOverlay.
  // IMPORTANT: Must be defined before GET /:id to avoid wildcard matching.
  .get("/by-page", async (c) => {
    const pageId = c.req.query("page_id");
    if (!pageId) return validationError(c, "page_id query parameter is required");

    const limitParam = c.req.query("limit");
    const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 500, 1), 1000) : 500;

    const db = getDrizzleDb();

    // Phase 4b: resolve slug to integer and query by page_id_int
    const intId = await resolvePageIntId(db, pageId);
    if (intId === null) return c.json({ quotes: [] });

    // Wrap all reads in a transaction to ensure a consistent snapshot (#1393).
    const quotes = await db.transaction(async (tx) => {
      // Step 1: Get all claim_page_references for this page (with footnote info)
      const refs = await tx
        .select({
          claimId: claimPageReferences.claimId,
          footnote: claimPageReferences.footnote,
          section: claimPageReferences.section,
        })
        .from(claimPageReferences)
        .where(eq(claimPageReferences.pageIdInt, intId))
        .orderBy(asc(claimPageReferences.footnote))
        .limit(limit);

      if (refs.length === 0) {
        return [] as Array<{
          footnote: number;
          url: string | null;
          resourceId: string | null;
          claimText: string;
          sourceQuote: string | null;
          sourceTitle: string | null;
          sourceType: string | null;
          quoteVerified: boolean;
          verificationScore: number | null;
          verifiedAt: string | null;
          accuracyVerdict: string | null;
          accuracyScore: number | null;
          accuracyIssues: string | null;
          accuracySupportingQuotes: string | null;
          verificationDifficulty: string | null;
          accuracyCheckedAt: string | null;
        }>;
      }

      const claimIds = [...new Set(refs.map((r) => r.claimId))];

      // Step 2: Fetch the claims themselves
      const claimRows = await tx
        .select()
        .from(claims)
        .where(inArray(claims.id, claimIds));

      const claimMap = new Map(claimRows.map((r) => [Number(r.id), r]));

      // Step 3: Fetch primary sources for these claims (limit to primary or first source)
      const sourcesRows = await tx
        .select()
        .from(claimSources)
        .where(inArray(claimSources.claimId, claimIds))
        .orderBy(desc(claimSources.isPrimary), asc(claimSources.addedAt));

      // Build a map: claimId → primary source (first one, preferring isPrimary)
      const sourceMap = new Map<number, typeof claimSources.$inferSelect>();
      for (const s of sourcesRows) {
        const cid = Number(s.claimId);
        if (!sourceMap.has(cid)) {
          sourceMap.set(cid, s);
        }
      }

      // Step 4: Build CitationQuote-compatible output
      return refs
        .filter((ref) => ref.footnote !== null && claimMap.has(Number(ref.claimId)))
        .map((ref) => {
          const claim = claimMap.get(Number(ref.claimId))!;
          const source = sourceMap.get(Number(ref.claimId));

          // Map claim verdict fields to the CitationQuote shape
          return {
            footnote: ref.footnote as number,
            url: source?.url ?? null,
            resourceId: source?.resourceId ?? null,
            claimText: claim.claimText,
            sourceQuote: source?.sourceQuote ?? claim.sourceQuote ?? null,
            sourceTitle: source?.sourceTitle ?? null,
            sourceType: source?.sourceType ?? null,
            quoteVerified: source?.sourceVerdict != null,
            verificationScore: source?.sourceVerdictScore ?? null,
            verifiedAt: source?.sourceCheckedAt?.toISOString() ?? null,
            accuracyVerdict: claim.claimVerdict ?? null,
            accuracyScore: claim.claimVerdictScore ?? null,
            accuracyIssues: claim.claimVerdictIssues ?? null,
            accuracySupportingQuotes: claim.claimVerdictQuotes ?? null,
            verificationDifficulty: claim.claimVerdictDifficulty ?? null,
            accuracyCheckedAt: claim.claimVerifiedAt?.toISOString() ?? null,
          };
        });
    });

    return c.json({ quotes });
  })

  // ---- GET /by-source-url — claims citing a specific source URL, across all pages ----
  // Replaces the deprecated GET /api/citations/quotes-by-url endpoint (#1311).
  // Returns cross-page citation data grouped by URL for the /source/[id] page.
  .get("/by-source-url", async (c) => {
    const url = c.req.query("url");
    if (!url) return validationError(c, "url query parameter is required");

    const limitParam = c.req.query("limit");
    const limit = limitParam
      ? Math.min(Math.max(parseInt(limitParam, 10) || 100, 1), 500)
      : 100;

    const db = getDrizzleDb();

    // Step 1: Find all claim_sources matching this URL
    const sourcesRows = await db
      .select()
      .from(claimSources)
      .where(eq(claimSources.url, url))
      .limit(limit);

    if (sourcesRows.length === 0) {
      return c.json({
        quotes: [] as Array<{
          pageId: string;
          footnote: number;
          url: string | null;
          resourceId: string | null;
          claimText: string;
          sourceQuote: string | null;
          sourceTitle: string | null;
          sourceType: string | null;
          quoteVerified: boolean;
          verificationScore: number | null;
          verifiedAt: string | null;
          accuracyVerdict: string | null;
          accuracyScore: number | null;
          accuracyIssues: string | null;
          accuracySupportingQuotes: string | null;
          verificationDifficulty: string | null;
          accuracyCheckedAt: string | null;
        }>,
        stats: {
          totalPages: 0 as number,
          totalQuotes: 0 as number,
          verified: 0 as number,
          accurate: 0 as number,
          inaccurate: 0 as number,
          unsupported: 0 as number,
          minorIssues: 0 as number,
        },
      });
    }

    const claimIds = [...new Set(sourcesRows.map((s) => s.claimId))];

    // Step 2: Fetch claims
    const claimRows = await db
      .select()
      .from(claims)
      .where(inArray(claims.id, claimIds));

    const claimMap = new Map(claimRows.map((r) => [Number(r.id), r]));

    // Step 3: Fetch page references for these claims.
    // Phase D2b: page_id_old dropped; join wiki_pages to get slug via page_id_int.
    const pageRefs = await db
      .select({
        id: claimPageReferences.id,
        claimId: claimPageReferences.claimId,
        pageSlug: wikiPages.id,
        footnote: claimPageReferences.footnote,
      })
      .from(claimPageReferences)
      .leftJoin(wikiPages, eq(claimPageReferences.pageIdInt, wikiPages.integerIdCol))
      .where(inArray(claimPageReferences.claimId, claimIds))
      .orderBy(asc(claimPageReferences.footnote));

    // Build source map: claimId → source row that matched our URL
    const sourceByClaimId = new Map<number, typeof claimSources.$inferSelect>();
    for (const s of sourcesRows) {
      sourceByClaimId.set(Number(s.claimId), s);
    }

    // Step 4: Build cross-page quotes. Each page reference generates one quote entry.
    // Skip refs with no recoverable page slug (shouldn't happen after Phase B dual-write).
    const quotes = pageRefs
      .filter((pr) => claimMap.has(Number(pr.claimId)) && pr.pageSlug != null)
      .map((pr) => {
        const claim = claimMap.get(Number(pr.claimId))!;
        const source = sourceByClaimId.get(Number(pr.claimId));

        return {
          pageId: pr.pageSlug!,
          footnote: pr.footnote ?? 0,
          url: source?.url ?? null,
          resourceId: source?.resourceId ?? null,
          claimText: claim.claimText,
          sourceQuote: source?.sourceQuote ?? claim.sourceQuote ?? null,
          sourceTitle: source?.sourceTitle ?? null,
          sourceType: source?.sourceType ?? null,
          quoteVerified: source?.sourceVerdict != null,
          verificationScore: source?.sourceVerdictScore ?? null,
          verifiedAt: source?.sourceCheckedAt?.toISOString() ?? null,
          accuracyVerdict: claim.claimVerdict ?? null,
          accuracyScore: claim.claimVerdictScore ?? null,
          accuracyIssues: claim.claimVerdictIssues ?? null,
          accuracySupportingQuotes: claim.claimVerdictQuotes ?? null,
          verificationDifficulty: claim.claimVerdictDifficulty ?? null,
          accuracyCheckedAt: claim.claimVerifiedAt?.toISOString() ?? null,
        };
      });

    // Step 5: Compute aggregate stats
    const pageIds = new Set(quotes.map((q) => q.pageId));
    let verified = 0, accurate = 0, inaccurate = 0, unsupported = 0, minorIssues = 0;
    for (const q of quotes) {
      if (q.accuracyVerdict === "accurate") accurate++;
      else if (q.accuracyVerdict === "inaccurate") inaccurate++;
      else if (q.accuracyVerdict === "unsupported") unsupported++;
      else if (q.accuracyVerdict === "minor_issues") minorIssues++;
      if (q.quoteVerified) verified++;
    }

    return c.json({
      quotes,
      stats: {
        totalPages: pageIds.size,
        totalQuotes: quotes.length,
        verified,
        accurate,
        inaccurate,
        unsupported,
        minorIssues,
      },
    });
  })

  // ---- GET /:id (get by ID) ----
  .get("/:id", async (c) => {
    const idStr = c.req.param("id");
    const id = Number(idStr);
    if (!Number.isInteger(id) || id <= 0) {
      return validationError(c, "Claim ID must be a positive integer");
    }

    const db = getDrizzleDb();
    const rows = await db
      .select()
      .from(claims)
      .where(eq(claims.id, id))
      .limit(1);

    if (rows.length === 0) {
      return notFoundError(c, `Claim not found: ${id}`);
    }

    // Always include sources for single claim fetches
    const sourcesRows = await db
      .select()
      .from(claimSources)
      .where(eq(claimSources.claimId, id))
      .orderBy(desc(claimSources.isPrimary), asc(claimSources.addedAt));

    return c.json(formatClaim(rows[0], sourcesRows));
  })
  // ---- GET /:id/page-references ----
  .get("/:id/page-references", async (c) => {
    const idStr = c.req.param("id");
    const id = Number(idStr);
    if (!Number.isInteger(id) || id <= 0) {
      return validationError(c, "Claim ID must be a positive integer");
    }

    const db = getDrizzleDb();
    // Phase D2b: page_id_old dropped; join wiki_pages to get slug via page_id_int
    const rows = await db
      .select({
        id: claimPageReferences.id,
        claimId: claimPageReferences.claimId,
        pageSlug: wikiPages.id,
        footnote: claimPageReferences.footnote,
        section: claimPageReferences.section,
        createdAt: claimPageReferences.createdAt,
      })
      .from(claimPageReferences)
      .leftJoin(wikiPages, eq(claimPageReferences.pageIdInt, wikiPages.integerIdCol))
      .where(eq(claimPageReferences.claimId, id))
      .orderBy(asc(claimPageReferences.footnote));

    return c.json({
      references: rows
        .filter((r) => r.pageSlug != null)
        .map((r) => ({
          id: Number(r.id),
          claimId: Number(r.claimId),
          pageId: r.pageSlug!,
          footnote: r.footnote,
          section: r.section,
          createdAt: r.createdAt?.toISOString() ?? new Date().toISOString(),
        })),
    });
  })
  // ---- POST /:id/page-references ----
  .post("/:id/page-references", async (c) => {
    const idStr = c.req.param("id");
    const id = Number(idStr);
    if (!Number.isInteger(id) || id <= 0) {
      return validationError(c, "Claim ID must be a positive integer");
    }

    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = PageRefInsertBodySchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const db = getDrizzleDb();

    // Verify claim exists
    const claimRows = await db.select({ id: claims.id }).from(claims).where(eq(claims.id, id)).limit(1);
    if (claimRows.length === 0) return notFoundError(c, `Claim not found: ${id}`);

    // Phase D2a: resolve slug to integer ID (no longer dual-writing page_id_old)
    const refPageIdInt = await resolvePageIntId(db, parsed.data.pageId);

    const rows = await db
      .insert(claimPageReferences)
      .values({
        claimId: id,
        pageIdInt: refPageIdInt,
        footnote: parsed.data.footnote ?? null,
        section: parsed.data.section ?? null,
        quoteText: parsed.data.quoteText ?? null,
        referenceId: parsed.data.referenceId ?? null,
      })
      .onConflictDoNothing()
      .returning();

    if (rows.length === 0) {
      return c.json({ message: "Reference already exists" }, 200);
    }

    return c.json({
      id: Number(rows[0].id),
      claimId: Number(rows[0].claimId),
      pageId: rows[0].pageId,
      footnote: rows[0].footnote,
      section: rows[0].section,
      quoteText: rows[0].quoteText,
      referenceId: rows[0].referenceId,
      createdAt: rows[0].createdAt?.toISOString() ?? new Date().toISOString(),
    }, 201);
  })
  // ---- POST /:id/page-references/batch ----
  .post("/:id/page-references/batch", async (c) => {
    const idStr = c.req.param("id");
    const id = Number(idStr);
    if (!Number.isInteger(id) || id <= 0) {
      return validationError(c, "Claim ID must be a positive integer");
    }

    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = ClaimPageReferenceBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const db = getDrizzleDb();

    // Verify claim exists
    const claimRows = await db.select({ id: claims.id }).from(claims).where(eq(claims.id, id)).limit(1);
    if (claimRows.length === 0) return notFoundError(c, `Claim not found: ${id}`);

    // Phase 4a: resolve page slugs to integer IDs for dual-write
    const batchRefPageIds = [...new Set(parsed.data.items.map((item) => item.pageId))];
    const batchRefIntIdMap = await resolvePageIntIds(db, batchRefPageIds);

    const values = parsed.data.items.map((item) => ({
      claimId: id,
      pageId: item.pageId,
      pageIdInt: batchRefIntIdMap.get(item.pageId) ?? null, // Phase 4a dual-write
      footnote: item.footnote ?? null,
      section: item.section ?? null,
    }));

    const rows = await db
      .insert(claimPageReferences)
      .values(values)
      .onConflictDoNothing()
      .returning();

    return c.json({ inserted: rows.length }, 201);
  });

export const claimsRoute = claimsApp;
export type ClaimsRoute = typeof claimsApp;
