import { Hono } from "hono";
import { z } from "zod";
import { eq, desc, count, and } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { pageImproveRuns, wikiPages } from "../schema.js";
import { SaveArtifactsSchema } from "../api-types.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  notFoundError,
  paginationQuery,
} from "./utils.js";
import { resolvePageIntId } from "./page-id-helpers.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 100;

const PaginationQuery = paginationQuery({ maxLimit: MAX_PAGE_SIZE, defaultLimit: 20 });

const ByPageQuery = z.object({
  page_id: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(10),
});

// ---- Helpers ----

function formatArtifactEntry(r: typeof pageImproveRuns.$inferSelect, pageSlug?: string | null) {
  return {
    id: r.id,
    pageId: pageSlug ?? "", // Phase D2b: page_id_old dropped; slug comes from wiki_pages JOIN
    engine: r.engine,
    tier: r.tier,
    directions: r.directions,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    durationS: r.durationS,
    totalCost: r.totalCost,
    sourceCache: r.sourceCache,
    researchSummary: r.researchSummary,
    citationAudit: r.citationAudit,
    costEntries: r.costEntries,
    costBreakdown: r.costBreakdown,
    sectionDiffs: r.sectionDiffs,
    qualityMetrics: r.qualityMetrics,
    qualityGatePassed: r.qualityGatePassed,
    qualityGaps: r.qualityGaps,
    toolCallCount: r.toolCallCount,
    refinementCycles: r.refinementCycles,
    phasesRun: r.phasesRun,
    createdAt: r.createdAt,
  };
}

const artifactsApp = new Hono()
  // ---- POST / (save artifacts from a run) ----
  .post("/", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SaveArtifactsSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const d = parsed.data;
    const db = getDrizzleDb();

    // Resolve slug to integer ID for page_id_int FK
    const pageIdInt = await resolvePageIntId(db, d.pageId);

    const rows = await db
      .insert(pageImproveRuns)
      .values({
        pageIdInt,
        engine: d.engine,
        tier: d.tier,
        directions: d.directions ?? null,
        startedAt: new Date(d.startedAt),
        completedAt: d.completedAt ? new Date(d.completedAt) : null,
        durationS: d.durationS ?? null,
        totalCost: d.totalCost ?? null,
        sourceCache: d.sourceCache ?? null,
        researchSummary: d.researchSummary ?? null,
        citationAudit: d.citationAudit ?? null,
        costEntries: d.costEntries ?? null,
        costBreakdown: d.costBreakdown ?? null,
        sectionDiffs: d.sectionDiffs ?? null,
        qualityMetrics: d.qualityMetrics ?? null,
        qualityGatePassed: d.qualityGatePassed ?? null,
        qualityGaps: d.qualityGaps ?? null,
        toolCallCount: d.toolCallCount ?? null,
        refinementCycles: d.refinementCycles ?? null,
        phasesRun: d.phasesRun ?? null,
      })
      .returning({
        id: pageImproveRuns.id,
        engine: pageImproveRuns.engine,
        startedAt: pageImproveRuns.startedAt,
        createdAt: pageImproveRuns.createdAt,
      });

    const row = rows[0];
    // pageId derived from input (page_id_old column dropped in D2b)
    return c.json({ ...row, pageId: d.pageId }, 201);
  })

  // ---- GET /by-page?page_id=X&limit=N (artifacts for a specific page) ----
  .get("/by-page", async (c) => {
    const parsed = ByPageQuery.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { page_id, limit } = parsed.data;
    const db = getDrizzleDb();

    // Phase 4b: resolve slug to integer and query by page_id_int
    const intId = await resolvePageIntId(db, page_id);
    if (intId === null) return c.json({ entries: [] });

    const rows = await db
      .select()
      .from(pageImproveRuns)
      .where(eq(pageImproveRuns.pageIdInt, intId))
      .orderBy(desc(pageImproveRuns.startedAt))
      .limit(limit);

    // page_id is the URL param (slug) — pass directly as the pageSlug override
    return c.json({ entries: rows.map((r) => formatArtifactEntry(r, page_id)) });
  })

  // ---- GET /all (paginated list of all artifacts) ----
  .get("/all", async (c) => {
    const parsed = PaginationQuery.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { limit, offset } = parsed.data;
    const db = getDrizzleDb();

    // Phase D2b: page_id_old dropped; join wiki_pages to get slug via page_id_int
    const rows = await db
      .select({
        run: pageImproveRuns,
        pageSlug: wikiPages.id,
      })
      .from(pageImproveRuns)
      .leftJoin(wikiPages, eq(pageImproveRuns.pageIdInt, wikiPages.integerIdCol))
      .orderBy(desc(pageImproveRuns.startedAt))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(pageImproveRuns);
    const total = countResult[0].count;

    return c.json({
      entries: rows.map((r) => formatArtifactEntry(r.run, r.pageSlug)),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /stats (aggregate statistics) ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const totalResult = await db
      .select({ count: count() })
      .from(pageImproveRuns);
    const totalRuns = totalResult[0].count;

    const byEngine = await db
      .select({
        engine: pageImproveRuns.engine,
        count: count(),
      })
      .from(pageImproveRuns)
      .groupBy(pageImproveRuns.engine);

    const byTier = await db
      .select({
        tier: pageImproveRuns.tier,
        count: count(),
      })
      .from(pageImproveRuns)
      .groupBy(pageImproveRuns.tier);

    return c.json({
      totalRuns,
      byEngine: Object.fromEntries(byEngine.map((r) => [r.engine, r.count])),
      byTier: Object.fromEntries(byTier.map((r) => [r.tier, r.count])),
    });
  })

  // ---- GET /:id (single artifact by ID) ----
  .get("/:id", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return validationError(c, "id must be a number");

    const db = getDrizzleDb();

    // Phase D2b: page_id_old dropped; join wiki_pages to get slug via page_id_int
    const rows = await db
      .select({
        run: pageImproveRuns,
        pageSlug: wikiPages.id,
      })
      .from(pageImproveRuns)
      .leftJoin(wikiPages, eq(pageImproveRuns.pageIdInt, wikiPages.integerIdCol))
      .where(eq(pageImproveRuns.id, id));

    if (rows.length === 0) {
      return notFoundError(c, "Artifact not found");
    }

    return c.json(formatArtifactEntry(rows[0].run, rows[0].pageSlug));
  });

export const artifactsRoute = artifactsApp;
export type ArtifactsRoute = typeof artifactsApp;
