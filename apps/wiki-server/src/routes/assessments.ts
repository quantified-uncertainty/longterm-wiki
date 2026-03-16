import { Hono } from "hono";
import { z } from "zod";
import { desc, sql } from "drizzle-orm";
import { getDrizzleDb, getDb } from "../db.js";
import { wikibasePageAssessments } from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  firstOrThrow,
  zv,
} from "./utils.js";
import {
  PageAssessmentSchema,
  PageAssessmentBatchSchema,
  VALID_ASSESSORS,
} from "../api-types.js";
import { logger as rootLogger } from "../logger.js";
import { resolvePageIntId, resolvePageIntIds } from "./page-id-helpers.js";

const logger = rootLogger.child({ component: "assessments" });

// ---- Raw SQL row types ----

interface LatestAssessmentRow {
  id: number;
  page_id_int: number;
  page_slug: string;
  assessor: string;
  method: string | null;
  model: string | null;
  quality: number | null;
  reader_importance: number | null;
  research_importance: number | null;
  tactical_value: number | null;
  rating_focus: number | null;
  rating_novelty: number | null;
  rating_rigor: number | null;
  rating_completeness: number | null;
  rating_concreteness: number | null;
  rating_actionability: number | null;
  rating_objectivity: number | null;
  structural_score: number | null;
  word_count: number | null;
  note: string | null;
  assessed_at: string;
}

interface AssessorCountRow {
  assessor: string;
  count: number;
}

interface UniqueCountRow {
  count: number;
}

// ---- Query schemas ----

const HistoryQuery = z.object({
  pageId: z.string().min(1).max(300),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  assessor: z.enum(VALID_ASSESSORS).optional(),
});

const LatestQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
  assessor: z.enum(VALID_ASSESSORS).optional(),
});

// ---- Route ----

const assessmentsApp = new Hono()

  // ---- POST / (record single assessment) ----

  .post("/", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = PageAssessmentSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const d = parsed.data;
    const db = getDrizzleDb();

    const pageIdInt = await resolvePageIntId(db, d.pageId);
    if (pageIdInt === null) {
      return c.json(
        { error: "not_found", message: `Page not found: ${d.pageId}` },
        404
      );
    }

    const rows = await db
      .insert(wikibasePageAssessments)
      .values({
        pageIdInt,
        assessor: d.assessor,
        method: d.method ?? null,
        model: d.model ?? null,
        quality: d.quality ?? null,
        readerImportance: d.readerImportance ?? null,
        researchImportance: d.researchImportance ?? null,
        tacticalValue: d.tacticalValue ?? null,
        ratingFocus: d.ratingFocus ?? null,
        ratingNovelty: d.ratingNovelty ?? null,
        ratingRigor: d.ratingRigor ?? null,
        ratingCompleteness: d.ratingCompleteness ?? null,
        ratingConcreteness: d.ratingConcreteness ?? null,
        ratingActionability: d.ratingActionability ?? null,
        ratingObjectivity: d.ratingObjectivity ?? null,
        structuralScore: d.structuralScore ?? null,
        wordCount: d.wordCount ?? null,
        note: d.note ?? null,
        ...(d.assessedAt ? { assessedAt: new Date(d.assessedAt) } : {}),
      })
      .returning({
        id: wikibasePageAssessments.id,
        assessor: wikibasePageAssessments.assessor,
        assessedAt: wikibasePageAssessments.assessedAt,
      });

    const row = firstOrThrow(rows, "assessment insert");
    return c.json({ ...row, pageId: d.pageId }, 201);
  })

  // ---- POST /batch (record multiple assessments) ----

  .post("/batch", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = PageAssessmentBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;
    const db = getDrizzleDb();

    // Resolve all page slugs to integer IDs
    const pageIds = [...new Set(items.map((d) => d.pageId))];
    const intIdMap = await resolvePageIntIds(db, pageIds);

    const allVals = items
      .filter((d) => intIdMap.has(d.pageId))
      .map((d) => ({
        pageIdInt: intIdMap.get(d.pageId)!,
        assessor: d.assessor,
        method: d.method ?? null,
        model: d.model ?? null,
        quality: d.quality ?? null,
        readerImportance: d.readerImportance ?? null,
        researchImportance: d.researchImportance ?? null,
        tacticalValue: d.tacticalValue ?? null,
        ratingFocus: d.ratingFocus ?? null,
        ratingNovelty: d.ratingNovelty ?? null,
        ratingRigor: d.ratingRigor ?? null,
        ratingCompleteness: d.ratingCompleteness ?? null,
        ratingConcreteness: d.ratingConcreteness ?? null,
        ratingActionability: d.ratingActionability ?? null,
        ratingObjectivity: d.ratingObjectivity ?? null,
        structuralScore: d.structuralScore ?? null,
        wordCount: d.wordCount ?? null,
        note: d.note ?? null,
        ...(d.assessedAt ? { assessedAt: new Date(d.assessedAt) } : {}),
      }));

    if (allVals.length === 0) {
      return c.json({ inserted: 0, skipped: items.length }, 201);
    }

    const results = await db
      .insert(wikibasePageAssessments)
      .values(allVals)
      .returning({ id: wikibasePageAssessments.id });

    const skipped = items.length - allVals.length;
    if (skipped > 0) {
      logger.warn(
        { skipped, total: items.length },
        "Some assessments skipped — page IDs not found"
      );
    }

    return c.json({ inserted: results.length, skipped }, 201);
  })

  // ---- GET / (assessment history for a page) ----

  .get("/", zv("query", HistoryQuery), async (c) => {
    const { pageId, limit, assessor } = c.req.valid("query");
    const db = getDrizzleDb();

    const intId = await resolvePageIntId(db, pageId);
    if (intId === null) return c.json({ pageId, assessments: [] });

    const rawDb = getDb();

    const rows = assessor
      ? await rawDb<LatestAssessmentRow[]>`
          SELECT id, page_id_int, assessor, method, model,
                 quality, reader_importance, research_importance, tactical_value,
                 rating_focus, rating_novelty, rating_rigor, rating_completeness,
                 rating_concreteness, rating_actionability, rating_objectivity,
                 structural_score, word_count, note, assessed_at
          FROM wikibase_page_assessments
          WHERE page_id_int = ${intId} AND assessor = ${assessor}
          ORDER BY assessed_at DESC
          LIMIT ${limit}
        `
      : await rawDb<LatestAssessmentRow[]>`
          SELECT id, page_id_int, assessor, method, model,
                 quality, reader_importance, research_importance, tactical_value,
                 rating_focus, rating_novelty, rating_rigor, rating_completeness,
                 rating_concreteness, rating_actionability, rating_objectivity,
                 structural_score, word_count, note, assessed_at
          FROM wikibase_page_assessments
          WHERE page_id_int = ${intId}
          ORDER BY assessed_at DESC
          LIMIT ${limit}
        `;

    return c.json({
      pageId,
      assessments: rows.map(formatAssessmentRow),
    });
  })

  // ---- GET /latest (latest per page per assessor) ----

  .get("/latest", zv("query", LatestQuery), async (c) => {
    const { limit, offset, assessor } = c.req.valid("query");
    const rawDb = getDb();

    const rows = assessor
      ? await rawDb<LatestAssessmentRow[]>`
          SELECT DISTINCT ON (wpa.page_id_int)
            wpa.id, wpa.page_id_int, ei.slug AS page_slug,
            wpa.assessor, wpa.method, wpa.model,
            wpa.quality, wpa.reader_importance, wpa.research_importance, wpa.tactical_value,
            wpa.rating_focus, wpa.rating_novelty, wpa.rating_rigor, wpa.rating_completeness,
            wpa.rating_concreteness, wpa.rating_actionability, wpa.rating_objectivity,
            wpa.structural_score, wpa.word_count, wpa.note, wpa.assessed_at
          FROM wikibase_page_assessments wpa
          JOIN entity_ids ei ON ei.numeric_id = wpa.page_id_int
          WHERE wpa.assessor = ${assessor} AND wpa.page_id_int IS NOT NULL
          ORDER BY wpa.page_id_int, wpa.assessed_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `
      : await rawDb<LatestAssessmentRow[]>`
          SELECT DISTINCT ON (wpa.page_id_int, wpa.assessor)
            wpa.id, wpa.page_id_int, ei.slug AS page_slug,
            wpa.assessor, wpa.method, wpa.model,
            wpa.quality, wpa.reader_importance, wpa.research_importance, wpa.tactical_value,
            wpa.rating_focus, wpa.rating_novelty, wpa.rating_rigor, wpa.rating_completeness,
            wpa.rating_concreteness, wpa.rating_actionability, wpa.rating_objectivity,
            wpa.structural_score, wpa.word_count, wpa.note, wpa.assessed_at
          FROM wikibase_page_assessments wpa
          JOIN entity_ids ei ON ei.numeric_id = wpa.page_id_int
          WHERE wpa.page_id_int IS NOT NULL
          ORDER BY wpa.page_id_int, wpa.assessor, wpa.assessed_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;

    return c.json({
      assessments: rows.map((r) => ({
        pageId: r.page_slug,
        ...formatAssessmentRow(r),
      })),
    });
  })

  // ---- GET /stats (aggregate statistics) ----

  .get("/stats", async (c) => {
    const rawDb = getDb();

    const [totalResult, uniquePagesResult, assessorDist] = await Promise.all([
      rawDb<UniqueCountRow[]>`
        SELECT count(*)::int AS count FROM wikibase_page_assessments
      `,
      rawDb<UniqueCountRow[]>`
        SELECT count(DISTINCT page_id_int)::int AS count FROM wikibase_page_assessments
      `,
      rawDb<AssessorCountRow[]>`
        SELECT assessor, count(*)::int AS count
        FROM wikibase_page_assessments
        GROUP BY assessor
      `,
    ]);

    return c.json({
      totalAssessments: totalResult[0]?.count ?? 0,
      uniquePages: uniquePagesResult[0]?.count ?? 0,
      assessorDistribution: Object.fromEntries(
        assessorDist.map((r) => [r.assessor, r.count])
      ),
    });
  });

// ---- Helpers ----

function formatAssessmentRow(r: LatestAssessmentRow) {
  return {
    id: r.id,
    assessor: r.assessor,
    method: r.method,
    model: r.model,
    quality: r.quality,
    readerImportance: r.reader_importance,
    researchImportance: r.research_importance,
    tacticalValue: r.tactical_value,
    ratingFocus: r.rating_focus,
    ratingNovelty: r.rating_novelty,
    ratingRigor: r.rating_rigor,
    ratingCompleteness: r.rating_completeness,
    ratingConcreteness: r.rating_concreteness,
    ratingActionability: r.rating_actionability,
    ratingObjectivity: r.rating_objectivity,
    structuralScore: r.structural_score,
    wordCount: r.word_count,
    note: r.note,
    assessedAt: r.assessed_at,
  };
}

export const assessmentsRoute = assessmentsApp;
export type AssessmentsRoute = typeof assessmentsApp;
