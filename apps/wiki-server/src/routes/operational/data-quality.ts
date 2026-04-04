/**
 * Data Quality Snapshots — point-in-time metrics across all data bases.
 *
 * POST /         — Capture a new snapshot (aggregates live DB metrics)
 * GET  /history  — List snapshots with pagination
 * GET  /latest   — Most recent snapshot
 */

import { Hono } from "hono";
import { z } from "zod";
import { sql, desc, count } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import {
  dataQualitySnapshots,
  personnel,
  grants,
  investments,
  fundingRounds,
  entities,
  wikiPages,
  facts,
} from "../../schema.js";
import { zv, clampedLimit } from "../shared/utils.js";
import { logger } from "../../logger.js";

// ---------------------------------------------------------------------------
// Row type for raw SQL snapshot aggregation
// ---------------------------------------------------------------------------

// Use Array<> for raw SQL result casts (matches integrity.ts pattern)
// to satisfy RowList<Record<string, unknown>[]> compatibility.

// ---------------------------------------------------------------------------
// Zod schemas for query validation
// ---------------------------------------------------------------------------

const HistoryQuerySchema = z.object({
  limit: clampedLimit(200, 50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const dataQualityApp = new Hono()
  // ---- POST / — Capture a new snapshot ----
  .post("/", async (c) => {
    const db = getDrizzleDb();

    try {
      // 1. Source-check verdict counts
      const verdictRows = (await db.execute(
        sql`SELECT verdict, COUNT(*)::text AS cnt FROM source_check_verdicts GROUP BY verdict`
      )) as Array<{ verdict: string; cnt: string }>;

      const verdictMap: Record<string, number> = {};
      let verdictsTotal = 0;
      for (const row of verdictRows) {
        verdictMap[row.verdict] = parseInt(row.cnt, 10);
        verdictsTotal += parseInt(row.cnt, 10);
      }

      const needsRecheckRows = (await db.execute(
        sql`SELECT COUNT(*)::text AS cnt FROM source_check_verdicts WHERE needs_recheck = true`
      )) as Array<{ cnt: string }>;
      const verdictsNeedsRecheck = parseInt(needsRecheckRows[0]?.cnt ?? "0", 10);

      // 2. Personnel coverage
      const personnelTotalRows = await db.select({ count: count() }).from(personnel);
      const personnelTotal = personnelTotalRows[0].count;

      const personnelWithSourceRows = (await db.execute(
        sql`SELECT COUNT(*)::text AS cnt FROM personnel WHERE source IS NOT NULL AND source != ''`
      )) as Array<{ cnt: string }>;
      const personnelWithSource = parseInt(personnelWithSourceRows[0]?.cnt ?? "0", 10);

      const personnelWithStartDateRows = (await db.execute(
        sql`SELECT COUNT(*)::text AS cnt FROM personnel WHERE start_date IS NOT NULL AND start_date != ''`
      )) as Array<{ cnt: string }>;
      const personnelWithStartDate = parseInt(personnelWithStartDateRows[0]?.cnt ?? "0", 10);

      // 3. Grants coverage
      const grantsTotalRows = await db.select({ count: count() }).from(grants);
      const grantsTotal = grantsTotalRows[0].count;

      const grantsWithSourceRows = (await db.execute(
        sql`SELECT COUNT(*)::text AS cnt FROM grants WHERE source IS NOT NULL AND source != ''`
      )) as Array<{ cnt: string }>;
      const grantsWithSource = parseInt(grantsWithSourceRows[0]?.cnt ?? "0", 10);

      // 4. Investments coverage
      const investmentsTotalRows = await db.select({ count: count() }).from(investments);
      const investmentsTotal = investmentsTotalRows[0].count;

      const investmentsWithSourceRows = (await db.execute(
        sql`SELECT COUNT(*)::text AS cnt FROM investments WHERE source IS NOT NULL AND source != ''`
      )) as Array<{ cnt: string }>;
      const investmentsWithSource = parseInt(investmentsWithSourceRows[0]?.cnt ?? "0", 10);

      // 5. Funding rounds
      const fundingRoundsTotalRows = await db.select({ count: count() }).from(fundingRounds);
      const fundingRoundsTotal = fundingRoundsTotalRows[0].count;

      // 6. Entities coverage
      const entitiesTotalRows = await db.select({ count: count() }).from(entities);
      const entitiesTotal = entitiesTotalRows[0].count;

      const entitiesWithWikiPageRows = (await db.execute(
        sql`SELECT COUNT(DISTINCT e.stable_id)::text AS cnt FROM entities e INNER JOIN wiki_pages wp ON wp.wiki_id = e.wiki_id WHERE e.wiki_id IS NOT NULL`
      )) as Array<{ cnt: string }>;
      const entitiesWithWikiPage = parseInt(entitiesWithWikiPageRows[0]?.cnt ?? "0", 10);

      // 7. FactBase counts
      const factbaseFactsRows = await db.select({ count: count() }).from(facts);
      const factbaseFacts = factbaseFactsRows[0].count;

      const factbaseEntitiesRows = (await db.execute(
        sql`SELECT COUNT(DISTINCT entity_id)::text AS cnt FROM facts`
      )) as Array<{ cnt: string }>;
      const factbaseEntities = parseInt(factbaseEntitiesRows[0]?.cnt ?? "0", 10);

      // 8. Pages
      const pagesTotalRows = await db.select({ count: count() }).from(wikiPages);
      const pagesTotal = pagesTotalRows[0].count;

      // ---- Insert snapshot ----
      const [snapshot] = await db
        .insert(dataQualitySnapshots)
        .values({
          verdictsTotal,
          verdictsConfirmed: verdictMap["confirmed"] ?? 0,
          verdictsContradicted: verdictMap["contradicted"] ?? 0,
          verdictsPartial: verdictMap["partial"] ?? 0,
          verdictsUnverifiable: verdictMap["unverifiable"] ?? 0,
          verdictsOutdated: verdictMap["outdated"] ?? 0,
          verdictsNeedsRecheck,
          personnelTotal,
          personnelWithSource,
          personnelWithStartDate,
          grantsTotal,
          grantsWithSource,
          investmentsTotal,
          investmentsWithSource,
          fundingRoundsTotal,
          entitiesTotal,
          entitiesWithWikiPage,
          factbaseEntities,
          factbaseFacts,
          pagesTotal,
        })
        .returning();

      logger.info({ snapshotId: snapshot.id }, "Data quality snapshot captured");

      return c.json({
        snapshot: {
          id: snapshot.id,
          capturedAt: snapshot.capturedAt.toISOString(),
          verdictsTotal: snapshot.verdictsTotal,
          verdictsConfirmed: snapshot.verdictsConfirmed,
          verdictsContradicted: snapshot.verdictsContradicted,
          verdictsPartial: snapshot.verdictsPartial,
          verdictsUnverifiable: snapshot.verdictsUnverifiable,
          verdictsOutdated: snapshot.verdictsOutdated,
          verdictsNeedsRecheck: snapshot.verdictsNeedsRecheck,
          personnelTotal: snapshot.personnelTotal,
          personnelWithSource: snapshot.personnelWithSource,
          personnelWithStartDate: snapshot.personnelWithStartDate,
          grantsTotal: snapshot.grantsTotal,
          grantsWithSource: snapshot.grantsWithSource,
          investmentsTotal: snapshot.investmentsTotal,
          investmentsWithSource: snapshot.investmentsWithSource,
          fundingRoundsTotal: snapshot.fundingRoundsTotal,
          entitiesTotal: snapshot.entitiesTotal,
          entitiesWithWikiPage: snapshot.entitiesWithWikiPage,
          factbaseEntities: snapshot.factbaseEntities,
          factbaseFacts: snapshot.factbaseFacts,
          pagesTotal: snapshot.pagesTotal,
          extra: snapshot.extra,
        },
      });
    } catch (err) {
      logger.error({ err }, "Failed to capture data quality snapshot");
      return c.json({ error: "Failed to capture snapshot" }, 500);
    }
  })

  // ---- GET /history — List snapshots ----
  .get("/history", zv("query", HistoryQuerySchema), async (c) => {
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(dataQualitySnapshots)
      .orderBy(desc(dataQualitySnapshots.capturedAt))
      .limit(limit)
      .offset(offset);

    const totalRows = await db.select({ count: count() }).from(dataQualitySnapshots);
    const total = totalRows[0].count;

    return c.json({
      snapshots: rows.map((r) => ({
        id: r.id,
        capturedAt: r.capturedAt.toISOString(),
        verdictsTotal: r.verdictsTotal,
        verdictsConfirmed: r.verdictsConfirmed,
        verdictsContradicted: r.verdictsContradicted,
        verdictsPartial: r.verdictsPartial,
        verdictsUnverifiable: r.verdictsUnverifiable,
        verdictsOutdated: r.verdictsOutdated,
        verdictsNeedsRecheck: r.verdictsNeedsRecheck,
        personnelTotal: r.personnelTotal,
        personnelWithSource: r.personnelWithSource,
        personnelWithStartDate: r.personnelWithStartDate,
        grantsTotal: r.grantsTotal,
        grantsWithSource: r.grantsWithSource,
        investmentsTotal: r.investmentsTotal,
        investmentsWithSource: r.investmentsWithSource,
        fundingRoundsTotal: r.fundingRoundsTotal,
        entitiesTotal: r.entitiesTotal,
        entitiesWithWikiPage: r.entitiesWithWikiPage,
        factbaseEntities: r.factbaseEntities,
        factbaseFacts: r.factbaseFacts,
        pagesTotal: r.pagesTotal,
        extra: r.extra,
      })),
      total,
    });
  })

  // ---- GET /latest — Most recent snapshot ----
  .get("/latest", async (c) => {
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(dataQualitySnapshots)
      .orderBy(desc(dataQualitySnapshots.capturedAt))
      .limit(1);

    if (rows.length === 0) {
      return c.json({ snapshot: null });
    }

    const r = rows[0];
    return c.json({
      snapshot: {
        id: r.id,
        capturedAt: r.capturedAt.toISOString(),
        verdictsTotal: r.verdictsTotal,
        verdictsConfirmed: r.verdictsConfirmed,
        verdictsContradicted: r.verdictsContradicted,
        verdictsPartial: r.verdictsPartial,
        verdictsUnverifiable: r.verdictsUnverifiable,
        verdictsOutdated: r.verdictsOutdated,
        verdictsNeedsRecheck: r.verdictsNeedsRecheck,
        personnelTotal: r.personnelTotal,
        personnelWithSource: r.personnelWithSource,
        personnelWithStartDate: r.personnelWithStartDate,
        grantsTotal: r.grantsTotal,
        grantsWithSource: r.grantsWithSource,
        investmentsTotal: r.investmentsTotal,
        investmentsWithSource: r.investmentsWithSource,
        fundingRoundsTotal: r.fundingRoundsTotal,
        entitiesTotal: r.entitiesTotal,
        entitiesWithWikiPage: r.entitiesWithWikiPage,
        factbaseEntities: r.factbaseEntities,
        factbaseFacts: r.factbaseFacts,
        pagesTotal: r.pagesTotal,
        extra: r.extra,
      },
    });
  });

export const dataQualityRoute = dataQualityApp;
export type DataQualityRoute = typeof dataQualityApp;
