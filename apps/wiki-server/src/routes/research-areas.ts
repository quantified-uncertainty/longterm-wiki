import { Hono } from "hono";
import { z } from "zod";
import { eq, count, sql, and } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
} from "./utils.js";
import { upsertThingsInTx } from "./thing-sync.js";
import {
  researchAreas,
  researchAreaOrganizations,
  researchAreaPapers,
  researchAreaRisks,
  grantResearchAreas,
  grants,
  resourceCitations,
  resources,
  wikiPages,
} from "../schema.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

const VALID_STATUSES = [
  "active",
  "emerging",
  "mature",
  "declining",
  "archived",
] as const;

// ---- Query schemas ----

const AllQuery = z.object({
  cluster: z.string().max(50).optional(),
  status: z.string().max(50).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Sync schemas ----

const SyncResearchAreaItemSchema = z.object({
  id: z.string().min(1).max(200),
  numericId: z.string().max(20).nullable().optional(),
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

const SyncResearchAreaBatchSchema = z.object({
  items: z.array(SyncResearchAreaItemSchema).min(1).max(200),
});

const SyncOrgLinkSchema = z.object({
  items: z.array(
    z.object({
      researchAreaId: z.string().min(1).max(200),
      organizationId: z.string().min(1).max(200),
      role: z.string().max(50).optional().default("active"),
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
      relevance: z.string().max(50).optional().default("addresses"),
      effectiveness: z.string().max(50).nullable().optional(),
      notes: z.string().max(2000).nullable().optional(),
    })
  ).min(1).max(500),
});

// ---- Helpers ----

function formatRow(r: typeof researchAreas.$inferSelect) {
  return {
    id: r.id,
    numericId: r.numericId,
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

    const orgCountMap = new Map(orgCounts.map((r) => [r.researchAreaId, r.count]));
    const paperCountMap = new Map(paperCounts.map((r) => [r.researchAreaId, r.count]));
    const grantStatsMap = new Map(
      grantStats.map((r) => [
        r.researchAreaId,
        { grantCount: r.grantCount, totalFunding: r.totalFunding },
      ])
    );
    const riskCountMap = new Map(riskCounts.map((r) => [r.researchAreaId, r.count]));

    const enriched = rows.map((r) => {
      const gs = grantStatsMap.get(r.id);
      return {
        ...formatRow(r),
        orgCount: orgCountMap.get(r.id) ?? 0,
        paperCount: paperCountMap.get(r.id) ?? 0,
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

    // Fetch related data in parallel
    const [orgs, papers, risks, children, topGrants, fundingByOrg] = await Promise.all([
      db
        .select()
        .from(researchAreaOrganizations)
        .where(eq(researchAreaOrganizations.researchAreaId, id)),
      db
        .select()
        .from(researchAreaPapers)
        .where(eq(researchAreaPapers.researchAreaId, id))
        .orderBy(researchAreaPapers.sortOrder),
      db
        .select()
        .from(researchAreaRisks)
        .where(eq(researchAreaRisks.researchAreaId, id)),
      db
        .select()
        .from(researchAreas)
        .where(eq(researchAreas.parentAreaId, id)),
      // Top grants by amount (up to 50)
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
        .limit(50),
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
        .orderBy(sql`COALESCE(SUM(${grants.amount}::numeric), 0) DESC`),
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
  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncResearchAreaBatchSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(
        c,
        parsed.error.issues.map((i) => i.message).join(", ")
      );
    }

    const db = getDrizzleDb();
    const now = new Date();
    let upserted = 0;

    await db.transaction(async (tx) => {
      for (const item of parsed.data.items) {
        await tx
          .insert(researchAreas)
          .values({
            id: item.id,
            numericId: item.numericId ?? null,
            title: item.title,
            description: item.description ?? null,
            status: item.status,
            cluster: item.cluster ?? null,
            parentAreaId: item.parentAreaId ?? null,
            firstProposed: item.firstProposed ?? null,
            firstProposedYear: item.firstProposedYear ?? null,
            tags: item.tags,
            metadata: item.metadata,
            source: item.source ?? null,
            notes: item.notes ?? null,
            syncedAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: researchAreas.id,
            set: {
              numericId: item.numericId ?? null,
              title: item.title,
              description: item.description ?? null,
              status: item.status,
              cluster: item.cluster ?? null,
              parentAreaId: item.parentAreaId ?? null,
              firstProposed: item.firstProposed ?? null,
              firstProposedYear: item.firstProposedYear ?? null,
              tags: item.tags,
              metadata: item.metadata,
              source: item.source ?? null,
              notes: item.notes ?? null,
              syncedAt: now,
              updatedAt: now,
            },
          });
        upserted++;
      }

      // Dual-write to things table
      await upsertThingsInTx(
        tx,
        parsed.data.items.map((ra) => ({
          id: ra.id,
          thingType: "research-area" as const,
          title: ra.title,
          sourceTable: "research_areas",
          sourceId: ra.id,
          description: ra.description,
          sourceUrl: ra.source,
        }))
      );
    });

    return c.json({ upserted });
  })

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
    let upserted = 0;

    await db.transaction(async (tx) => {
      for (const item of parsed.data.items) {
        await tx
          .insert(researchAreaOrganizations)
          .values({
            researchAreaId: item.researchAreaId,
            organizationId: item.organizationId,
            role: item.role,
            notes: item.notes ?? null,
          })
          .onConflictDoUpdate({
            target: [
              researchAreaOrganizations.researchAreaId,
              researchAreaOrganizations.organizationId,
            ],
            set: {
              role: item.role,
              notes: item.notes ?? null,
            },
          });
        upserted++;
      }
    });

    return c.json({ upserted });
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
    let inserted = 0;

    // Group items by researchAreaId for delete+insert pattern
    const byArea = new Map<string, typeof parsed.data.items>();
    for (const item of parsed.data.items) {
      const existing = byArea.get(item.researchAreaId) ?? [];
      existing.push(item);
      byArea.set(item.researchAreaId, existing);
    }

    await db.transaction(async (tx) => {
      // Delete existing papers for each area being synced, then insert fresh
      for (const [areaId, items] of byArea) {
        await tx
          .delete(researchAreaPapers)
          .where(eq(researchAreaPapers.researchAreaId, areaId));

        for (const item of items) {
          await tx.insert(researchAreaPapers).values({
            researchAreaId: item.researchAreaId,
            resourceId: item.resourceId ?? null,
            title: item.title,
            url: item.url ?? null,
            authors: item.authors ?? null,
            publishedDate: item.publishedDate ?? null,
            citationCount: item.citationCount ?? null,
            isSeminal: item.isSeminal,
            sortOrder: item.sortOrder,
            notes: item.notes ?? null,
          });
          inserted++;
        }
      }
    });

    return c.json({ inserted });
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

    // Bulk upsert using VALUES pattern
    const { items } = parsed.data;
    const now = new Date();
    let upserted = 0;

    // Process in chunks to avoid too-large SQL statements
    const CHUNK_SIZE = 500;
    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
      const chunk = items.slice(i, i + CHUNK_SIZE);
      await db.transaction(async (tx) => {
        for (const item of chunk) {
          await tx
            .insert(grantResearchAreas)
            .values({
              grantId: item.grantId,
              researchAreaId: item.researchAreaId,
              confidence: item.confidence,
              createdAt: now,
            })
            .onConflictDoUpdate({
              target: [
                grantResearchAreas.grantId,
                grantResearchAreas.researchAreaId,
              ],
              set: {
                confidence: item.confidence,
              },
            });
          upserted++;
        }
      });
    }

    return c.json({ upserted });
  })

  // ---- POST /backfill-papers-from-citations ----
  // Backfills research_area_papers from resource citations on wiki pages
  // linked to research areas via numeric_id.
  .post("/backfill-papers-from-citations", async (c) => {
    const db = getDrizzleDb();

    // Use raw SQL for the complex join + insert
    const result = await db.execute(sql`
      INSERT INTO research_area_papers (research_area_id, resource_id, title, url, authors, published_date, sort_order)
      SELECT
        ra.id,
        r.id,
        COALESCE(r.title, 'Untitled'),
        r.url,
        CASE WHEN r.authors IS NOT NULL THEN r.authors::text END,
        r.published_date::text,
        0
      FROM research_areas ra
      JOIN wiki_pages wp ON ra.numeric_id = wp.numeric_id AND ra.numeric_id IS NOT NULL
      JOIN resource_citations rc ON rc.page_id_old = wp.id
      JOIN resources r ON rc.resource_id = r.id
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
    let upserted = 0;

    await db.transaction(async (tx) => {
      for (const item of parsed.data.items) {
        await tx
          .insert(researchAreaRisks)
          .values({
            researchAreaId: item.researchAreaId,
            riskId: item.riskId,
            relevance: item.relevance,
            effectiveness: item.effectiveness ?? null,
            notes: item.notes ?? null,
          })
          .onConflictDoUpdate({
            target: [
              researchAreaRisks.researchAreaId,
              researchAreaRisks.riskId,
            ],
            set: {
              relevance: item.relevance,
              effectiveness: item.effectiveness ?? null,
              notes: item.notes ?? null,
            },
          });
        upserted++;
      }
    });

    return c.json({ upserted });
  });

export const researchAreasRoute = researchAreasApp;
export type ResearchAreasRoute = typeof researchAreasApp;
