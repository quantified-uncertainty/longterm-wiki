import { Hono } from "hono";
import { z } from "zod";
import { eq, desc, count, and } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { improveRunArtifacts } from "../schema.js";
import { SaveArtifactsSchema } from "../api-types.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  notFoundError,
} from "./utils.js";

export const artifactsRoute = new Hono();

// ---- Constants ----

const MAX_PAGE_SIZE = 100;

const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const ByPageQuery = z.object({
  page_id: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(10),
});

// ---- Helpers ----

function formatArtifactEntry(r: typeof improveRunArtifacts.$inferSelect) {
  return {
    id: r.id,
    pageId: r.pageId,
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

// ---- POST / (save artifacts from a run) ----

artifactsRoute.post("/", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = SaveArtifactsSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const d = parsed.data;
  const db = getDrizzleDb();

  const rows = await db
    .insert(improveRunArtifacts)
    .values({
      pageId: d.pageId,
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
      id: improveRunArtifacts.id,
      pageId: improveRunArtifacts.pageId,
      engine: improveRunArtifacts.engine,
      startedAt: improveRunArtifacts.startedAt,
      createdAt: improveRunArtifacts.createdAt,
    });

  return c.json(rows[0], 201);
});

// ---- GET /by-page?page_id=X&limit=N (artifacts for a specific page) ----

artifactsRoute.get("/by-page", async (c) => {
  const parsed = ByPageQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { page_id, limit } = parsed.data;
  const db = getDrizzleDb();

  const rows = await db
    .select()
    .from(improveRunArtifacts)
    .where(eq(improveRunArtifacts.pageId, page_id))
    .orderBy(desc(improveRunArtifacts.startedAt))
    .limit(limit);

  return c.json({ entries: rows.map(formatArtifactEntry) });
});

// ---- GET /all (paginated list of all artifacts) ----

artifactsRoute.get("/all", async (c) => {
  const parsed = PaginationQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { limit, offset } = parsed.data;
  const db = getDrizzleDb();

  const rows = await db
    .select()
    .from(improveRunArtifacts)
    .orderBy(desc(improveRunArtifacts.startedAt))
    .limit(limit)
    .offset(offset);

  const countResult = await db
    .select({ count: count() })
    .from(improveRunArtifacts);
  const total = countResult[0].count;

  return c.json({
    entries: rows.map(formatArtifactEntry),
    total,
    limit,
    offset,
  });
});

// ---- GET /stats (aggregate statistics) ----

artifactsRoute.get("/stats", async (c) => {
  const db = getDrizzleDb();

  const totalResult = await db
    .select({ count: count() })
    .from(improveRunArtifacts);
  const totalRuns = totalResult[0].count;

  const byEngine = await db
    .select({
      engine: improveRunArtifacts.engine,
      count: count(),
    })
    .from(improveRunArtifacts)
    .groupBy(improveRunArtifacts.engine);

  const byTier = await db
    .select({
      tier: improveRunArtifacts.tier,
      count: count(),
    })
    .from(improveRunArtifacts)
    .groupBy(improveRunArtifacts.tier);

  return c.json({
    totalRuns,
    byEngine: Object.fromEntries(byEngine.map((r) => [r.engine, r.count])),
    byTier: Object.fromEntries(byTier.map((r) => [r.tier, r.count])),
  });
});

// ---- GET /:id (single artifact by ID) ----

artifactsRoute.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return validationError(c, "id must be a number");

  const db = getDrizzleDb();

  const rows = await db
    .select()
    .from(improveRunArtifacts)
    .where(eq(improveRunArtifacts.id, id));

  if (rows.length === 0) {
    return notFoundError(c, "Artifact not found");
  }

  return c.json(formatArtifactEntry(rows[0]));
});
