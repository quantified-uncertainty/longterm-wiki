/**
 * Content Metrics Route — Syncs build-time content metrics to PG
 *
 * Handles coverage scores, update schedule, structural metrics, and
 * content similarity data computed by build-data.mjs.
 *
 * Part of the PG-First Migration (Epic #2428, Issue #2434).
 */

import { Hono } from "hono";
import { getDb, type SqlQuery } from "../db.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  dbError,
} from "./utils.js";
import {
  SyncContentMetricsBatchSchema,
  SyncSimilarityBatchSchema,
} from "../api-types.js";

// ---- Advisory lock keys ----
const CONTENT_METRICS_SYNC_LOCK = 7_294_802;
const SIMILARITY_SYNC_LOCK = 7_294_803;

const contentMetricsApp = new Hono()
  // ---- POST /sync ----
  // Upserts coverage, schedule, and structural metrics onto wiki_pages rows.
  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncContentMetricsBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { pages } = parsed.data;
    const rawDb = getDb();

    try {
      let updated = 0;

      await rawDb.begin(async (txRaw) => {
        // Known workaround: postgres.js transaction typing requires double-cast
        const tx = txRaw as unknown as SqlQuery;
        await tx`SELECT pg_advisory_xact_lock(${CONTENT_METRICS_SYNC_LOCK})`;

        // Batch update using jsonb_to_recordset for efficiency
        for (let i = 0; i < pages.length; i += 200) {
          const batch = pages.slice(i, i + 200);

          await tx`
            UPDATE wiki_pages wp SET
              coverage_passing = t."coveragePassing",
              coverage_total = t."coverageTotal",
              coverage_items = t."coverageItems",
              update_frequency = t."updateFrequency",
              days_since_update = t."daysSinceUpdate",
              days_until_due = t."daysUntilDue",
              staleness = t.staleness,
              update_priority = t."updatePriority",
              section_count = t."sectionCount",
              table_count = t."tableCount",
              diagram_count = t."diagramCount",
              footnote_count = t."footnoteCount",
              internal_links = t."internalLinks",
              external_links = t."externalLinks",
              updated_at = now()
            FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
            AS t(
              "pageId" text,
              "coveragePassing" integer,
              "coverageTotal" integer,
              "coverageItems" jsonb,
              "updateFrequency" integer,
              "daysSinceUpdate" integer,
              "daysUntilDue" integer,
              staleness real,
              "updatePriority" real,
              "sectionCount" integer,
              "tableCount" integer,
              "diagramCount" integer,
              "footnoteCount" integer,
              "internalLinks" integer,
              "externalLinks" integer
            )
            WHERE wp.id = t."pageId"
          `;

          updated += batch.length;
        }
      });

      return c.json({ updated });
    } catch (err) {
      return dbError(c, "content-metrics sync", err, { pageCount: pages.length });
    }
  })

  // ---- POST /similarity/sync ----
  // Replaces (or appends to) the page similarity table.
  .post("/similarity/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncSimilarityBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items, replace } = parsed.data;
    const rawDb = getDb();

    try {
      let upserted = 0;

      await rawDb.begin(async (txRaw) => {
        // Known workaround: postgres.js transaction typing requires double-cast
        const tx = txRaw as unknown as SqlQuery;
        await tx`SELECT pg_advisory_xact_lock(${SIMILARITY_SYNC_LOCK})`;

        if (replace) {
          await tx`DELETE FROM wikibase_page_similarity`;
        }

        for (let i = 0; i < items.length; i += 500) {
          const batch = items.slice(i, i + 500);

          await tx`
            INSERT INTO wikibase_page_similarity (page_id, similar_page_id, similarity, synced_at)
            SELECT t."pageId", t."similarPageId", t.similarity, now()
            FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
            AS t("pageId" text, "similarPageId" text, similarity real)
            WHERE EXISTS (SELECT 1 FROM wiki_pages WHERE id = t."pageId")
              AND EXISTS (SELECT 1 FROM wiki_pages WHERE id = t."similarPageId")
            ON CONFLICT (page_id, similar_page_id)
            DO UPDATE SET similarity = EXCLUDED.similarity, synced_at = now()
          `;

          upserted += batch.length;
        }
      });

      return c.json({ upserted });
    } catch (err) {
      return dbError(c, "similarity sync", err, { itemCount: items.length });
    }
  })

  // ---- GET /stats ----
  // Returns summary statistics for content metrics.
  .get("/stats", async (c) => {
    const rawDb = getDb();

    interface CoverageRow {
      with_coverage: number;
      avg_passing: string;
      avg_total: string;
    }

    interface ScheduleRow {
      with_schedule: number;
      overdue: number;
      avg_priority: string;
    }

    interface SimilarityRow {
      total_pairs: number;
      unique_pages: number;
      avg_similarity: string;
    }

    const [coverageResult, scheduleResult, similarityResult] = await Promise.all([
      rawDb<CoverageRow[]>`
        SELECT
          COUNT(*)::int FILTER (WHERE coverage_total > 0) AS with_coverage,
          ROUND(AVG(coverage_passing)::numeric, 1) AS avg_passing,
          ROUND(AVG(coverage_total)::numeric, 1) AS avg_total
        FROM wiki_pages
        WHERE coverage_total IS NOT NULL
      `,
      rawDb<ScheduleRow[]>`
        SELECT
          COUNT(*)::int FILTER (WHERE update_frequency IS NOT NULL) AS with_schedule,
          COUNT(*)::int FILTER (WHERE days_until_due < 0) AS overdue,
          ROUND(AVG(update_priority)::numeric, 2) AS avg_priority
        FROM wiki_pages
        WHERE update_frequency IS NOT NULL
      `,
      rawDb<SimilarityRow[]>`
        SELECT
          COUNT(*)::int AS total_pairs,
          COUNT(DISTINCT page_id)::int AS unique_pages,
          ROUND(AVG(similarity)::numeric, 1) AS avg_similarity
        FROM wikibase_page_similarity
      `,
    ]);

    return c.json({
      coverage: {
        pagesWithCoverage: coverageResult[0]?.with_coverage ?? 0,
        avgPassing: parseFloat(coverageResult[0]?.avg_passing ?? "0"),
        avgTotal: parseFloat(coverageResult[0]?.avg_total ?? "0"),
      },
      schedule: {
        pagesWithSchedule: scheduleResult[0]?.with_schedule ?? 0,
        overdue: scheduleResult[0]?.overdue ?? 0,
        avgPriority: parseFloat(scheduleResult[0]?.avg_priority ?? "0"),
      },
      similarity: {
        totalPairs: similarityResult[0]?.total_pairs ?? 0,
        uniquePages: similarityResult[0]?.unique_pages ?? 0,
        avgSimilarity: parseFloat(similarityResult[0]?.avg_similarity ?? "0"),
      },
    });
  });

export const contentMetricsRoute = contentMetricsApp;
export type ContentMetricsRoute = typeof contentMetricsApp;
