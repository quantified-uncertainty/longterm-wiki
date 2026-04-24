import { Hono } from "hono";
import { z } from "zod";
import { eq, count, sql, and, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
  clampedLimit,
} from "../shared/utils.js";
import { validateEntityRefs } from "../shared/validate-entity-refs.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { createSyncHandler } from "./sync-factory.js";
import {
  researchAreas,
  researchAreaOrganizations,
  researchAreaPapers,
  researchAreaRisks,
  grantResearchAreas,
  grants,
  researchAreaEvaluations,
  researchAreaScores,
  evaluationDimensions,
  resources,
} from "../../schema.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

// QUA-623: safety caps on related-data subqueries. Hit today is small
// (single-digit to low-hundreds per area), but `.limit()` prevents silent
// 503s if the tables grow.
const RELATED_DATA_CAP = 500;
const TOP_GRANTS_CAP = 50;
const FUNDING_BREAKDOWN_CAP = 200;
const SCORES_LIST_CAP = 5_000;
const EVALUATIONS_PER_AREA_CAP = 1_000;

// Max possible standard deviation for a 1-10 scale (bimodal 50/50 split at extremes).
// Used to normalize stdDev into a 0-1 "model agreement" metric.
const MAX_SCORE_STDDEV = 4.5;

const VALID_STATUSES = [
  "active",
  "emerging",
  "mature",
  "declining",
  "archived",
] as const;

// CHECK constraints — must match apps/wiki-server/drizzle/0173_add_check_constraints_phase2.sql
const VALID_ORG_ROLES = [
  "pioneer",
  "active",
  "major",
  "funder",
  "emerging",
] as const;

const VALID_RISK_RELEVANCE = ["addresses", "studies", "exacerbates"] as const;

const VALID_RISK_EFFECTIVENESS = [
  "high",
  "moderate",
  "low",
  "uncertain",
] as const;

// ---- Query schemas ----

const AllQuery = z.object({
  cluster: z.string().max(50).optional(),
  status: z.string().max(50).optional(),
  limit: clampedLimit(MAX_PAGE_SIZE, 200),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Sync schemas ----

const SyncResearchAreaItemSchema = z.object({
  id: z.string().min(1).max(200),
  wikiId: z.string().max(20).nullable().optional(),
  title: z.string().min(1).max(500),
  description: z.string().max(5000).nullable().optional(),
  status: z.enum(VALID_STATUSES).optional().default("active"),
  cluster: z.string().max(100).nullable().optional(),
  parentAreaId: z.string().max(200).nullable().optional(),
  firstProposed: z.string().max(200).nullable().optional(),
  firstProposedYear: z.number().int().nullable().optional(),
  tags: z.array(z.string()).optional().default([]),
  metadata: z.record(z.unknown()).optional().default({}),
  source: z.string().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const SyncOrgLinkSchema = z.object({
  items: z.array(
    z.object({
      researchAreaId: z.string().min(1).max(200),
      organizationId: z.string().min(1).max(200),
      role: z.enum(VALID_ORG_ROLES).optional().default("active"),
      notes: z.string().max(2000).nullable().optional(),
    })
  ).min(1).max(500),
});

const SyncPaperSchema = z.object({
  items: z.array(
    z.object({
      researchAreaId: z.string().min(1).max(200),
      resourceId: z.string().max(200).nullable().optional(),
      title: z.string().min(1).max(1000),
      url: z.string().max(2000).nullable().optional(),
      authors: z.string().max(1000).nullable().optional(),
      publishedDate: z.string().max(20).nullable().optional(),
      citationCount: z.number().int().nullable().optional(),
      isSeminal: z.boolean().optional().default(false),
      sortOrder: z.number().int().optional().default(0),
      notes: z.string().max(2000).nullable().optional(),
    })
  ).min(1).max(500),
});

const SyncGrantLinkSchema = z.object({
  items: z.array(
    z.object({
      grantId: z.string().min(1).max(10),
      researchAreaId: z.string().min(1).max(200),
      confidence: z.number().min(0).max(1).optional().default(0.5),
    })
  ).min(1).max(2000),
});

const SyncRiskLinkSchema = z.object({
  items: z.array(
    z.object({
      researchAreaId: z.string().min(1).max(200),
      riskId: z.string().min(1).max(200),
      relevance: z.enum(VALID_RISK_RELEVANCE).optional().default("addresses"),
      effectiveness: z.enum(VALID_RISK_EFFECTIVENESS).nullable().optional(),
      notes: z.string().max(2000).nullable().optional(),
    })
  ).min(1).max(500),
});

// ---- Helpers ----

function formatRow(r: typeof researchAreas.$inferSelect) {
  return {
    id: r.id,
    wikiId: r.wikiId,
    title: r.title,
    description: r.description,
    status: r.status,
    cluster: r.cluster,
    parentAreaId: r.parentAreaId,
    firstProposed: r.firstProposed,
    firstProposedYear: r.firstProposedYear,
    tags: r.tags,
    metadata: r.metadata,
    source: r.source,
    notes: r.notes,
    syncedAt: r.syncedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ---- Route definition (method-chained for Hono RPC type inference) ----

const researchAreasApp = new Hono()

  // ---- GET /stats ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const [[statsRow], clusterRows, statusRows] = await Promise.all([
      db.select({ total: count() }).from(researchAreas),
      db
        .select({
          cluster: researchAreas.cluster,
          count: count(),
        })
        .from(researchAreas)
        .groupBy(researchAreas.cluster),
      db
        .select({
          status: researchAreas.status,
          count: count(),
        })
        .from(researchAreas)
        .groupBy(researchAreas.status),
    ]);

    const byCluster: Record<string, number> = {};
    for (const row of clusterRows) {
      byCluster[row.cluster ?? "uncategorized"] = row.count;
    }

    const byStatus: Record<string, number> = {};
    for (const row of statusRows) {
      byStatus[row.status] = row.count;
    }

    return c.json({ total: statsRow.total, byCluster, byStatus });
  })

  // ---- GET /all ----
  .get("/all", zv("query", AllQuery), async (c) => {
    const { cluster, status, limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions: SQL[] = [];
    if (cluster) conditions.push(eq(researchAreas.cluster, cluster));
    if (status) conditions.push(eq(researchAreas.status, status));

    const rows = await db
      .select()
      .from(researchAreas)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(researchAreas.cluster, researchAreas.title)
      .limit(limit)
      .offset(offset);

    return c.json({ researchAreas: rows.map(formatRow) });
  })

  // ---- GET /enriched — areas with computed stats ----
  .get("/enriched", zv("query", AllQuery), async (c) => {
    const { cluster, status, limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions: SQL[] = [];
    if (cluster) conditions.push(eq(researchAreas.cluster, cluster));
    if (status) conditions.push(eq(researchAreas.status, status));

    // Fetch base rows and all count aggregations in parallel
    const [rows, orgCounts, paperCounts, grantStats, riskCounts] = await Promise.all([
      db
        .select()
        .from(researchAreas)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(researchAreas.cluster, researchAreas.title)
        .limit(limit)
        .offset(offset),
      db
        .select({
          researchAreaId: researchAreaOrganizations.researchAreaId,
          count: count(),
        })
        .from(researchAreaOrganizations)
        .groupBy(researchAreaOrganizations.researchAreaId),
      db
        .select({
          researchAreaId: researchAreaPapers.researchAreaId,
          count: count(),
        })
        .from(researchAreaPapers)
        .groupBy(researchAreaPapers.researchAreaId),
      db
        .select({
          researchAreaId: grantResearchAreas.researchAreaId,
          grantCount: count(),
          totalFunding: sql<string>`COALESCE(SUM(${grants.amount}::numeric), 0)`,
        })
        .from(grantResearchAreas)
        .leftJoin(grants, eq(grantResearchAreas.grantId, grants.id))
        .groupBy(grantResearchAreas.researchAreaId),
      db
        .select({
          researchAreaId: researchAreaRisks.researchAreaId,
          count: count(),
        })
        .from(researchAreaRisks)
        .groupBy(researchAreaRisks.researchAreaId),
    ]);

    // Direct count maps (only counts resources linked directly to each area)
    const directOrgCountMap = new Map(orgCounts.map((r) => [r.researchAreaId, r.count]));
    const directPaperCountMap = new Map(paperCounts.map((r) => [r.researchAreaId, r.count]));
    const grantStatsMap = new Map(
      grantStats.map((r) => [
        r.researchAreaId,
        { grantCount: r.grantCount, totalFunding: r.totalFunding },
      ])
    );
    const riskCountMap = new Map(riskCounts.map((r) => [r.researchAreaId, r.count]));

    // Build effective counts that inherit from parent areas.
    // The hierarchy is max 2 levels deep (parent → child), so a simple
    // lookup suffices — no recursive CTE needed.
    // For each area: effective count = own direct count + parent's direct count
    const getEffectiveCount = (
      directMap: Map<string, number>,
      areaId: string,
      parentAreaId: string | null
    ): number => {
      const own = directMap.get(areaId) ?? 0;
      const inherited = parentAreaId ? (directMap.get(parentAreaId) ?? 0) : 0;
      return own + inherited;
    };

    const enriched = rows.map((r) => {
      const gs = grantStatsMap.get(r.id);
      return {
        ...formatRow(r),
        orgCount: getEffectiveCount(directOrgCountMap, r.id, r.parentAreaId),
        paperCount: getEffectiveCount(directPaperCountMap, r.id, r.parentAreaId),
        grantCount: gs?.grantCount ?? 0,
        totalFunding: gs?.totalFunding ?? "0",
        riskCount: riskCountMap.get(r.id) ?? 0,
      };
    });

    return c.json({ researchAreas: enriched });
  })

  // ---- GET /:id ----
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const db = getDrizzleDb();

    const [row] = await db
      .select()
      .from(researchAreas)
      .where(eq(researchAreas.id, id))
      .limit(1);

    if (!row) {
      return c.json(
        { error: "not_found", message: `Research area ${id} not found` },
        404
      );
    }

    // Fetch related data in parallel. Each subquery is capped (QUA-623) to
    // prevent unbounded scans as these tables grow.
    const [orgs, papers, risks, children, topGrants, fundingByOrg] = await Promise.all([
      db
        .select()
        .from(researchAreaOrganizations)
        .where(eq(researchAreaOrganizations.researchAreaId, id))
        .limit(RELATED_DATA_CAP),
      db
        .select()
        .from(researchAreaPapers)
        .where(eq(researchAreaPapers.researchAreaId, id))
        .orderBy(researchAreaPapers.sortOrder)
        .limit(RELATED_DATA_CAP),
      db
        .select()
        .from(researchAreaRisks)
        .where(eq(researchAreaRisks.researchAreaId, id))
        .limit(RELATED_DATA_CAP),
      db
        .select()
        .from(researchAreas)
        .where(eq(researchAreas.parentAreaId, id))
        .limit(RELATED_DATA_CAP),
      // Top grants by amount (cap: TOP_GRANTS_CAP)
      db
        .select({
          id: grants.id,
          name: grants.name,
          amount: grants.amount,
          date: grants.date,
          organizationId: grants.organizationId,
          granteeId: grants.granteeId,
          confidence: grantResearchAreas.confidence,
        })
        .from(grantResearchAreas)
        .innerJoin(grants, eq(grantResearchAreas.grantId, grants.id))
        .where(eq(grantResearchAreas.researchAreaId, id))
        .orderBy(sql`${grants.amount}::numeric DESC NULLS LAST`)
        .limit(TOP_GRANTS_CAP),
      // Funding breakdown by funder org
      db
        .select({
          organizationId: grants.organizationId,
          grantCount: count(),
          totalAmount: sql<string>`COALESCE(SUM(${grants.amount}::numeric), 0)`,
        })
        .from(grantResearchAreas)
        .innerJoin(grants, eq(grantResearchAreas.grantId, grants.id))
        .where(eq(grantResearchAreas.researchAreaId, id))
        .groupBy(grants.organizationId)
        .orderBy(sql`COALESCE(SUM(${grants.amount}::numeric), 0) DESC`)
        .limit(FUNDING_BREAKDOWN_CAP),
    ]);

    return c.json({
      ...formatRow(row),
      organizations: orgs.map((o) => ({
        organizationId: o.organizationId,
        role: o.role,
        notes: o.notes,
      })),
      papers: papers.map((p) => ({
        id: p.id,
        resourceId: p.resourceId,
        title: p.title,
        url: p.url,
        authors: p.authors,
        publishedDate: p.publishedDate,
        citationCount: p.citationCount,
        isSeminal: p.isSeminal,
        sortOrder: p.sortOrder,
        notes: p.notes,
      })),
      risks: risks.map((r) => ({
        riskId: r.riskId,
        relevance: r.relevance,
        effectiveness: r.effectiveness,
        notes: r.notes,
      })),
      children: children.map(formatRow),
      grants: topGrants.map((g) => ({
        id: g.id,
        name: g.name,
        amount: g.amount != null ? Number(g.amount) : null,
        date: g.date,
        organizationId: g.organizationId,
        granteeId: g.granteeId,
        confidence: g.confidence,
      })),
      fundingByOrg: fundingByOrg.map((f) => ({
        organizationId: f.organizationId,
        grantCount: f.grantCount,
        totalAmount: f.totalAmount,
      })),
    });
  })

  // ---- POST /sync ----
  .post(
    "/sync",
    createSyncHandler({
      name: "research-areas",
      table: researchAreas,
      syncSchema: SyncResearchAreaItemSchema,
      // QUA-507: pointer-only things write.
      toThing: (item) => ({
        id: item.id,
        thingType: "research-area" as const,
        sourceTable: "research_areas",
        sourceId: item.id,
        sourceUrl: item.source,
      }),
    }),
  )

  // ---- POST /sync-organizations ----
  .post("/sync-organizations", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncOrgLinkSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(
        c,
        parsed.error.issues.map((i) => i.message).join(", ")
      );
    }

    const db = getDrizzleDb();
    const { items } = parsed.data;

    const refError = await validateEntityRefs(c, db, [
      { fieldName: "organizationId", ids: items.map((i) => i.organizationId) },
    ]);
    if (refError) return refError;

    const allVals = items.map((item) => ({
      researchAreaId: item.researchAreaId,
      organizationId: item.organizationId,
      role: item.role,
      notes: item.notes ?? null,
    }));

    await db
      .insert(researchAreaOrganizations)
      .values(allVals)
      .onConflictDoUpdate({
        target: [
          researchAreaOrganizations.researchAreaId,
          researchAreaOrganizations.organizationId,
        ],
        set: {
          role: sql`excluded.role`,
          notes: sql`excluded.notes`,
        },
      });

    return c.json({ upserted: items.length });
  })

  // ---- POST /sync-papers ----
  .post("/sync-papers", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncPaperSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(
        c,
        parsed.error.issues.map((i) => i.message).join(", ")
      );
    }

    const db = getDrizzleDb();
    const { items } = parsed.data;

    // Group items by researchAreaId for delete+insert pattern
    const byArea = new Map<string, typeof items>();
    for (const item of items) {
      const existing = byArea.get(item.researchAreaId) ?? [];
      existing.push(item);
      byArea.set(item.researchAreaId, existing);
    }

    // QUA-565 Phase B.2: research_area_papers.resource_id now references
    // resources.stable_id. Translate any incoming hex16 values → sid_ via
    // a single lookup before the transaction. Items whose resourceId is
    // already a sid_ (or doesn't match any resources.id) pass through
    // unchanged; the FK enforces validity at insert time.
    const inputResourceIds = items
      .map((item) => item.resourceId)
      .filter((v): v is string => !!v);
    const hexToStableId = new Map<string, string>();
    if (inputResourceIds.length > 0) {
      const resourceRows = await db
        .select({ id: resources.id, stableId: resources.stableId })
        .from(resources)
        .where(inArray(resources.id, inputResourceIds));
      for (const r of resourceRows) {
        if (r.stableId) hexToStableId.set(r.id, r.stableId);
      }
    }

    await db.transaction(async (tx) => {
      // Delete existing papers for each area being synced, then bulk insert fresh
      for (const [areaId, areaItems] of byArea) {
        await tx
          .delete(researchAreaPapers)
          .where(eq(researchAreaPapers.researchAreaId, areaId));

        await tx.insert(researchAreaPapers).values(
          areaItems.map((item) => ({
            researchAreaId: item.researchAreaId,
            resourceId: item.resourceId
              ? hexToStableId.get(item.resourceId) ?? item.resourceId
              : null,
            title: item.title,
            url: item.url ?? null,
            authors: item.authors ?? null,
            publishedDate: item.publishedDate ?? null,
            citationCount: item.citationCount ?? null,
            isSeminal: item.isSeminal,
            sortOrder: item.sortOrder,
            notes: item.notes ?? null,
          }))
        );
      }
    });

    return c.json({ inserted: items.length });
  })

  // ---- POST /sync-grant-links ----
  .post("/sync-grant-links", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncGrantLinkSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(
        c,
        parsed.error.issues.map((i) => i.message).join(", ")
      );
    }

    const db = getDrizzleDb();
    const { items } = parsed.data;
    const now = new Date();

    // Process in chunks to avoid too-large SQL statements
    const CHUNK_SIZE = 500;
    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
      const chunk = items.slice(i, i + CHUNK_SIZE);
      await db
        .insert(grantResearchAreas)
        .values(
          chunk.map((item) => ({
            grantId: item.grantId,
            researchAreaId: item.researchAreaId,
            confidence: item.confidence,
            createdAt: now,
          }))
        )
        .onConflictDoUpdate({
          target: [
            grantResearchAreas.grantId,
            grantResearchAreas.researchAreaId,
          ],
          set: {
            confidence: sql`excluded.confidence`,
          },
        });
    }

    return c.json({ upserted: items.length });
  })

  // ---- POST /backfill-papers-from-citations ----
  // Backfills research_area_papers from resource citations on wiki pages
  // linked to research areas via wiki_id.
  .post("/backfill-papers-from-citations", async (c) => {
    const db = getDrizzleDb();

    // Use raw SQL for the complex join + insert.
    // QUA-565 Phase B.2: research_area_papers.resource_id references
    // resources.stable_id, so we SELECT r.stable_id (not r.id).
    // QUA-566 Phase B.3: resource_citations.resource_id also now references
    // resources.stable_id, so the upstream JOIN is on r.stable_id as well.
    const result = await db.execute(sql`
      INSERT INTO research_area_papers (research_area_id, resource_id, title, url, authors, published_date, sort_order)
      SELECT
        ra.id,
        r.stable_id,
        COALESCE(r.title, 'Untitled'),
        r.url,
        CASE WHEN r.authors IS NOT NULL
          THEN array_to_string(ARRAY(SELECT jsonb_array_elements_text(r.authors)), ', ')
        END,
        r.published_date::text,
        0
      FROM research_areas ra
      JOIN wiki_pages wp ON ra.wiki_id = wp.wiki_id AND ra.wiki_id IS NOT NULL
      JOIN resource_citations rc ON rc.page_id = wp.id
      JOIN resources r ON rc.resource_id = r.stable_id
      WHERE r.url IS NOT NULL
      ON CONFLICT (research_area_id, url) WHERE url IS NOT NULL DO NOTHING
    `);

    const inserted = "rowCount" in result ? Number(result.rowCount) : 0;
    return c.json({ inserted });
  })

  // ---- POST /sync-risks ----
  .post("/sync-risks", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncRiskLinkSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(
        c,
        parsed.error.issues.map((i) => i.message).join(", ")
      );
    }

    const db = getDrizzleDb();
    const { items } = parsed.data;

    const allVals = items.map((item) => ({
      researchAreaId: item.researchAreaId,
      riskId: item.riskId,
      relevance: item.relevance,
      effectiveness: item.effectiveness ?? null,
      notes: item.notes ?? null,
    }));

    await db
      .insert(researchAreaRisks)
      .values(allVals)
      .onConflictDoUpdate({
        target: [
          researchAreaRisks.researchAreaId,
          researchAreaRisks.riskId,
        ],
        set: {
          relevance: sql`excluded.relevance`,
          effectiveness: sql`excluded.effectiveness`,
          notes: sql`excluded.notes`,
        },
      });

    return c.json({ upserted: items.length });
  })

  // ---- GET /evaluations/dimensions — list all evaluation dimensions ----
  .get("/evaluations/dimensions", async (c) => {
    const db = getDrizzleDb();
    const rows = await db
      .select()
      .from(evaluationDimensions)
      .orderBy(evaluationDimensions.sortOrder);

    return c.json({
      dimensions: rows.map((r) => ({
        id: r.id,
        label: r.label,
        description: r.description,
        category: r.category,
        scaleMin: r.scaleMin,
        scaleMax: r.scaleMax,
        higherIsBetter: r.higherIsBetter,
        sortOrder: r.sortOrder,
      })),
    });
  })

  // ---- GET /evaluations/scores — all consensus scores (for directory table) ----
  .get(
    "/evaluations/scores",
    zv(
      "query",
      z.object({
        dimension: z.string().max(100).optional(),
      })
    ),
    async (c) => {
      const { dimension } = c.req.valid("query");
      const db = getDrizzleDb();

      const conditions: SQL[] = [];
      if (dimension) conditions.push(eq(researchAreaScores.dimension, dimension));

      const rows = await db
        .select()
        .from(researchAreaScores)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(researchAreaScores.researchAreaId, researchAreaScores.dimension)
        .limit(SCORES_LIST_CAP);

      return c.json({
        scores: rows.map((r) => ({
          researchAreaId: r.researchAreaId,
          dimension: r.dimension,
          meanScore: r.meanScore,
          medianScore: r.medianScore,
          stdDev: r.stdDev,
          minScore: r.minScore,
          maxScore: r.maxScore,
          numEvaluators: r.numEvaluators,
          modelAgreement: r.modelAgreement,
          lastComputed: r.lastComputed,
        })),
      });
    }
  )

  // ---- GET /evaluations/by-area/:id — all evaluations for a specific area ----
  .get("/evaluations/by-area/:id", async (c) => {
    const areaId = c.req.param("id");
    const db = getDrizzleDb();

    const [evalRows, scoreRows] = await Promise.all([
      db
        .select()
        .from(researchAreaEvaluations)
        .where(eq(researchAreaEvaluations.researchAreaId, areaId))
        .orderBy(researchAreaEvaluations.dimension, researchAreaEvaluations.evaluatedAt)
        .limit(EVALUATIONS_PER_AREA_CAP),
      db
        .select()
        .from(researchAreaScores)
        .where(eq(researchAreaScores.researchAreaId, areaId))
        .orderBy(researchAreaScores.dimension)
        .limit(RELATED_DATA_CAP),
    ]);

    return c.json({
      researchAreaId: areaId,
      evaluations: evalRows.map((r) => ({
        id: r.id,
        dimension: r.dimension,
        score: r.score,
        confidence: r.confidence,
        reasoning: r.reasoning,
        evaluatorType: r.evaluatorType,
        evaluatorId: r.evaluatorId,
        promptVersion: r.promptVersion,
        evaluatedAt: r.evaluatedAt,
      })),
      scores: scoreRows.map((r) => ({
        dimension: r.dimension,
        meanScore: r.meanScore,
        medianScore: r.medianScore,
        stdDev: r.stdDev,
        minScore: r.minScore,
        maxScore: r.maxScore,
        numEvaluators: r.numEvaluators,
        modelAgreement: r.modelAgreement,
        lastComputed: r.lastComputed,
      })),
    });
  })

  // ---- POST /evaluations/sync — upsert evaluations ----
  .post("/evaluations/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const SyncEvaluationSchema = z.object({
      items: z.array(
        z.object({
          researchAreaId: z.string().min(1).max(200),
          dimension: z.string().min(1).max(100),
          score: z.number().min(1).max(10),
          confidence: z.number().min(0).max(1).optional(),
          reasoning: z.string().max(5000).optional(),
          evaluatorType: z.enum(["llm", "human"]).default("llm"),
          evaluatorId: z.string().min(1).max(200),
          promptVersion: z.string().max(100).optional(),
        })
      ).min(1).max(1000),
    });

    const parsed = SyncEvaluationSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(
        c,
        parsed.error.issues.map((i) => i.message).join(", ")
      );
    }

    const db = getDrizzleDb();
    const now = new Date();
    const { items } = parsed.data;

    const allVals = items.map((item) => ({
      researchAreaId: item.researchAreaId,
      dimension: item.dimension,
      score: item.score,
      confidence: item.confidence ?? null,
      reasoning: item.reasoning ?? null,
      evaluatorType: item.evaluatorType,
      evaluatorId: item.evaluatorId,
      promptVersion: item.promptVersion ?? "",
      evaluatedAt: now,
    }));

    await db
      .insert(researchAreaEvaluations)
      .values(allVals)
      .onConflictDoUpdate({
        target: [
          researchAreaEvaluations.researchAreaId,
          researchAreaEvaluations.dimension,
          researchAreaEvaluations.evaluatorId,
          researchAreaEvaluations.promptVersion,
        ],
        set: {
          score: sql`excluded.score`,
          confidence: sql`excluded.confidence`,
          reasoning: sql`excluded.reasoning`,
          evaluatedAt: sql`excluded.evaluated_at`,
        },
      });

    return c.json({ upserted: items.length });
  })

  // ---- POST /evaluations/recompute-scores — recompute consensus from evaluations ----
  .post("/evaluations/recompute-scores", async (c) => {
    const db = getDrizzleDb();

    // Compute aggregate scores per (area, dimension) from all evaluations
    const aggregated = await db
      .select({
        researchAreaId: researchAreaEvaluations.researchAreaId,
        dimension: researchAreaEvaluations.dimension,
        meanScore: sql<number>`AVG(${researchAreaEvaluations.score})`,
        medianScore: sql<number>`PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${researchAreaEvaluations.score})`,
        stdDev: sql<number>`STDDEV(${researchAreaEvaluations.score})`,
        minScore: sql<number>`MIN(${researchAreaEvaluations.score})`,
        maxScore: sql<number>`MAX(${researchAreaEvaluations.score})`,
        numEvaluators: count(),
      })
      .from(researchAreaEvaluations)
      .groupBy(
        researchAreaEvaluations.researchAreaId,
        researchAreaEvaluations.dimension
      );

    if (aggregated.length === 0) {
      return c.json({ recomputed: 0 });
    }

    const now = new Date();

    const allVals = aggregated.map((row) => {
      const stdDev = row.stdDev ?? 0;
      const modelAgreement = Math.max(0, 1 - stdDev / MAX_SCORE_STDDEV);
      return {
        researchAreaId: row.researchAreaId,
        dimension: row.dimension,
        meanScore: row.meanScore,
        medianScore: row.medianScore,
        stdDev: row.stdDev,
        minScore: row.minScore,
        maxScore: row.maxScore,
        numEvaluators: row.numEvaluators,
        modelAgreement,
        lastComputed: now,
      };
    });

    await db
      .insert(researchAreaScores)
      .values(allVals)
      .onConflictDoUpdate({
        target: [
          researchAreaScores.researchAreaId,
          researchAreaScores.dimension,
        ],
        set: {
          meanScore: sql`excluded.mean_score`,
          medianScore: sql`excluded.median_score`,
          stdDev: sql`excluded.std_dev`,
          minScore: sql`excluded.min_score`,
          maxScore: sql`excluded.max_score`,
          numEvaluators: sql`excluded.num_evaluators`,
          modelAgreement: sql`excluded.model_agreement`,
          lastComputed: sql`excluded.last_computed`,
        },
      });

    return c.json({ recomputed: allVals.length });
  })

  .post("/delete-batch", deleteBatchHandler(researchAreas, "research_areas"));

export const researchAreasRoute = researchAreasApp;
export type ResearchAreasRoute = typeof researchAreasApp;
