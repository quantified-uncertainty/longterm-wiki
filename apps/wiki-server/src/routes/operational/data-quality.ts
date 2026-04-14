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
import {
  ID_FORMAT_BUCKET_NAMES,
  ID_FORMAT_SOURCE_TABLES,
  type IdFormatAudit,
  type IdFormatBucketName,
  type IdFormatSourceTableName,
} from "../../api-types.js";

// ---------------------------------------------------------------------------
// Row type for raw SQL snapshot aggregation
// ---------------------------------------------------------------------------

// Use Array<> for raw SQL result casts (matches integrity.ts pattern)
// to satisfy RowList<Record<string, unknown>[]> compatibility.

// ---------------------------------------------------------------------------
// ID Format Audit (QUA-407 / QUA-439)
// ---------------------------------------------------------------------------
//
// Classifies atomic primary-key ID columns into coexisting formats so the
// dashboard can show sprawl at a glance and QUA-43 has a measurable target.
//
// Related code: apps/web/src/app/internal/entity-profile/sanitize-raw-ids.ts
// uses similar regexes for render-time sanitization. The shapes match but
// the taxonomies are different (this file splits lowercase-hex by length
// 8 vs 16; sanitize-raw-ids.ts groups 8–12 together). Keep the *shapes*
// aligned — if a new ID format appears, update both files.
//
// Source columns (NOT `things.source_id` — `things.source_id` for facts is a
// composite `<entityStableId>:<factId>`, which defeats classification):
//   - facts.fact_id                        → bucket for fact IDs
//   - resources.id (primary key)           → bucket for resource IDs

const ID_FORMAT_REGEXES = {
  canonical_f: "^f_[A-Za-z0-9]{8,}$",
  canonical_sid: "^sid_[A-Za-z0-9]{10}$",
  legacy_hex8: "^[0-9a-f]{8}$",
  legacy_alnum10:
    "^(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9])[A-Za-z0-9]{10}$",
  legacy_hex16: "^[0-9a-f]{16}$",
} as const;


type IdFormatAuditRow = {
  facts_canonical_f: string;
  facts_canonical_sid: string;
  facts_legacy_hex8: string;
  facts_legacy_alnum10: string;
  facts_legacy_hex16: string;
  facts_total: string;
  resources_canonical_f: string;
  resources_canonical_sid: string;
  resources_legacy_hex8: string;
  resources_legacy_alnum10: string;
  resources_legacy_hex16: string;
  resources_total: string;
};

function emptyBuckets(): Record<IdFormatBucketName, number> {
  return {
    canonical_f: 0,
    canonical_sid: 0,
    legacy_hex8: 0,
    legacy_alnum10: 0,
    legacy_hex16: 0,
    other: 0,
  };
}

const NAMED_BUCKETS: ReadonlyArray<Exclude<IdFormatBucketName, "other">> = [
  "canonical_f",
  "canonical_sid",
  "legacy_hex8",
  "legacy_alnum10",
  "legacy_hex16",
];

export async function captureIdFormatAudit(
  db: ReturnType<typeof getDrizzleDb>
): Promise<IdFormatAudit> {
  const rows = await db.transaction(async (tx) => {
    // SET LOCAL only takes effect inside a transaction; bounds the query
    // so a planner regression fails fast instead of eating the
    // groundskeeper task's 60s budget.
    await tx.execute(sql`SET LOCAL statement_timeout = '30000'`);
    return (await tx.execute(
      sql`
      WITH facts_audit AS (SELECT
        COUNT(*) FILTER (WHERE fact_id ~ ${ID_FORMAT_REGEXES.canonical_f})::text    AS facts_canonical_f,
        COUNT(*) FILTER (WHERE fact_id ~ ${ID_FORMAT_REGEXES.canonical_sid})::text  AS facts_canonical_sid,
        COUNT(*) FILTER (WHERE fact_id ~ ${ID_FORMAT_REGEXES.legacy_hex8})::text    AS facts_legacy_hex8,
        COUNT(*) FILTER (WHERE fact_id ~ ${ID_FORMAT_REGEXES.legacy_alnum10})::text AS facts_legacy_alnum10,
        COUNT(*) FILTER (WHERE fact_id ~ ${ID_FORMAT_REGEXES.legacy_hex16})::text   AS facts_legacy_hex16,
        COUNT(*)::text                                                              AS facts_total
      FROM facts WHERE fact_id IS NOT NULL),
      resources_audit AS (SELECT
        COUNT(*) FILTER (WHERE id ~ ${ID_FORMAT_REGEXES.canonical_f})::text         AS resources_canonical_f,
        COUNT(*) FILTER (WHERE id ~ ${ID_FORMAT_REGEXES.canonical_sid})::text       AS resources_canonical_sid,
        COUNT(*) FILTER (WHERE id ~ ${ID_FORMAT_REGEXES.legacy_hex8})::text         AS resources_legacy_hex8,
        COUNT(*) FILTER (WHERE id ~ ${ID_FORMAT_REGEXES.legacy_alnum10})::text      AS resources_legacy_alnum10,
        COUNT(*) FILTER (WHERE id ~ ${ID_FORMAT_REGEXES.legacy_hex16})::text        AS resources_legacy_hex16,
        COUNT(*)::text                                                              AS resources_total
      FROM resources WHERE id IS NOT NULL)
      SELECT * FROM facts_audit, resources_audit
    `
    )) as IdFormatAuditRow[];
  });

  const row = rows[0];
  const bySourceTable: Record<
    IdFormatSourceTableName,
    Record<IdFormatBucketName, number>
  > = {
    facts: emptyBuckets(),
    resources: emptyBuckets(),
  };

  if (row) {
    for (const table of ID_FORMAT_SOURCE_TABLES) {
      const buckets = bySourceTable[table];
      let namedSum = 0;
      for (const b of NAMED_BUCKETS) {
        const key = `${table}_${b}` as keyof IdFormatAuditRow;
        const n = Number(row[key] ?? "0");
        buckets[b] = Number.isFinite(n) ? n : 0;
        namedSum += buckets[b];
      }
      const totalKey = `${table}_total` as keyof IdFormatAuditRow;
      const total = Number(row[totalKey] ?? "0");
      buckets.other = Math.max(0, (Number.isFinite(total) ? total : 0) - namedSum);
    }
  }

  const totals = emptyBuckets();
  for (const b of ID_FORMAT_BUCKET_NAMES) {
    totals[b] = bySourceTable.facts[b] + bySourceTable.resources[b];
  }

  return {
    scannedAt: new Date().toISOString(),
    totals,
    bySourceTable,
  };
}

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

      // 9. Entity-resources count
      const entityResourceRows = (await db.execute(
        sql`SELECT COUNT(*)::text AS cnt FROM entity_resources`
      )) as Array<{ cnt: string }>;
      const entityResourcesTotal = parseInt(entityResourceRows[0]?.cnt ?? "0", 10);

      // 10. Claims pipeline
      const claimsPipelineRows = (await db.execute(
        sql`SELECT
          COUNT(*)::text AS total,
          COUNT(*) FILTER (WHERE status = 'verified')::text AS verified,
          COUNT(*) FILTER (WHERE status = 'contradicted')::text AS contradicted,
          COUNT(*) FILTER (WHERE status = 'pending')::text AS pending,
          COUNT(*) FILTER (WHERE status = 'unverifiable')::text AS unverifiable
        FROM proposed_claims`
      )) as Array<{ total: string; verified: string; contradicted: string; pending: string; unverifiable: string }>;

      const claimRecordLinksRows = (await db.execute(
        sql`SELECT COUNT(*)::text AS cnt FROM claim_record_links`
      )) as Array<{ cnt: string }>;

      const claimsExtra = {
        claimsTotal: parseInt(claimsPipelineRows[0]?.total ?? "0", 10),
        claimsVerified: parseInt(claimsPipelineRows[0]?.verified ?? "0", 10),
        claimsContradicted: parseInt(claimsPipelineRows[0]?.contradicted ?? "0", 10),
        claimsPending: parseInt(claimsPipelineRows[0]?.pending ?? "0", 10),
        claimsUnverifiable: parseInt(claimsPipelineRows[0]?.unverifiable ?? "0", 10),
        claimRecordLinks: parseInt(claimRecordLinksRows[0]?.cnt ?? "0", 10),
      };

      // 11. ID format audit over `things` (QUA-407 / QUA-439).
      // Single-pass COUNT(*) FILTER aggregation over the composite
      // (source_table, source_id) index. Bounded to 30s via
      // SET LOCAL statement_timeout so a planner regression fails fast
      // instead of eating the groundskeeper task's 60s budget.
      const idFormatAudit = await captureIdFormatAudit(db);

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
          extra: {
            entityResourcesTotal,
            ...claimsExtra,
            idFormatAudit,
          },
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
