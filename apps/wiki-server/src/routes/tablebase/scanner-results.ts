import { randomUUID } from "crypto";
import { Hono } from "hono";
import { z } from "zod";
import { eq, desc, count, sql } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import {
  tablebaseScannerResults,
  entities,
  grants,
  personnel,
  fundingRounds,
  investments,
  benchmarkResults,
  sourceVerdicts,
} from "../../schema.js";
import { zv, clampedLimit } from "../shared/utils.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { validateEntityRefs } from "../shared/validate-entity-refs.js";

const MAX_PAGE_SIZE = 500;
const MAX_BATCH_SIZE = 5000;

const LatestQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 200),
  offset: z.coerce.number().int().min(0).default(0),
  recordType: z.string().max(100).optional(),
  entityType: z.string().max(100).optional(),
});

const TrendsQuery = z.object({
  entityId: z.string().max(200).optional(),
  recordType: z.string().max(100).optional(),
  limit: clampedLimit(50, 10),
});

const SyncItemSchema = z.object({
  scanRunId: z.string().min(1).max(200),
  recordType: z.string().min(1).max(100),
  entityId: z.string().min(1).max(200),
  entityName: z.string().min(1).max(500),
  entityType: z.string().min(1).max(100),
  totalRecords: z.number().int().min(0),
  verifiedRecords: z.number().int().min(0).default(0),
  completenessPct: z.number().min(0).max(100),
  missingFields: z.array(z.string()).default([]),
  entityImportance: z.number().nullable().optional(),
  scannedAt: z.string().datetime().optional(),
});

const SyncBatchSchema = z.object({
  items: z.array(SyncItemSchema).min(1).max(MAX_BATCH_SIZE),
});

type SyncItem = z.infer<typeof SyncItemSchema>;

interface ScannerResultRow {
  id: number;
  scanRunId: string;
  recordType: string;
  entityId: string;
  entityName: string;
  entityType: string;
  totalRecords: number;
  verifiedRecords: number;
  completenessPct: number;
  missingFields: unknown;
  entityImportance: number | null;
  scannedAt: Date;
  createdAt: Date;
}

function formatRow(r: ScannerResultRow) {
  return {
    id: r.id,
    scanRunId: r.scanRunId,
    recordType: r.recordType,
    entityId: r.entityId,
    entityName: r.entityName,
    entityType: r.entityType,
    totalRecords: r.totalRecords,
    verifiedRecords: r.verifiedRecords,
    completenessPct: r.completenessPct,
    missingFields: r.missingFields,
    entityImportance: r.entityImportance,
    scannedAt: r.scannedAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Server-side scan: compute coverage metrics via SQL
// ---------------------------------------------------------------------------

interface ScanRow {
  entityId: string;
  entityName: string;
  entityType: string;
  recordType: string;
  totalRecords: number;
  verifiedRecords: number;
  completenessPct: number;
  missingFields: string[];
}

/**
 * Run a full server-side scan by querying PG directly.
 *
 * Returns one row per (entity, record_type) pair.
 * Coverage heuristics match the crux/tablebase/scanner.ts logic:
 *   - grants: % of grants with granteeId linked
 *   - personnel: min(100, count * 5) — 20+ records = 100%
 *   - funding_rounds: binary (has any = 100%, none = 0%)
 *   - investments: binary
 *   - benchmark_results: min(100, count * 10) — 10+ = 100%
 *   - source_quality: 100 - unverifiable_count * 5 (capped at 0)
 */
async function runServerSideScan(): Promise<ScanRow[]> {
  const db = getDrizzleDb();
  const rows: ScanRow[] = [];

  // 1. Grants — per org, completeness = % with grantee linked
  const grantRows = await db.execute<{
    entity_id: string;
    entity_name: string;
    total: string;
    linked: string;
  }>(sql`
    SELECT
      e.stable_id AS entity_id,
      e.title AS entity_name,
      COUNT(*)::int AS total,
      COUNT(g.grantee_id)::int AS linked
    FROM ${grants} g
    JOIN ${entities} e ON e.stable_id = COALESCE(g.org_entity_id, g.organization_id)
    GROUP BY e.stable_id, e.title
    HAVING COUNT(*) > 0
  `);

  for (const r of grantRows) {
    const total = Number(r.total);
    const linked = Number(r.linked);
    const pct = total > 0 ? Math.round((linked / total) * 100) : 100;
    const missing: string[] = [];
    if (linked < total) missing.push(`${total - linked} grants missing granteeId`);
    rows.push({
      entityId: r.entity_id,
      entityName: r.entity_name,
      entityType: "organization",
      recordType: "grants",
      totalRecords: total,
      verifiedRecords: linked,
      completenessPct: pct,
      missingFields: missing,
    });
  }

  // Shared org/model entity lists for subsequent per-record-type scans
  const orgEntities = await db
    .select({ stableId: entities.stableId, title: entities.title })
    .from(entities)
    .where(eq(entities.entityType, "organization"));

  const modelEntities = await db
    .select({ stableId: entities.stableId, title: entities.title })
    .from(entities)
    .where(eq(entities.entityType, "ai-model"));

  // 2. Personnel — per org, min(100, count * 5)
  const personnelRows = await db.execute<{
    entity_id: string;
    entity_name: string;
    total: string;
  }>(sql`
    SELECT
      e.stable_id AS entity_id,
      e.title AS entity_name,
      COUNT(*)::int AS total
    FROM ${personnel} p
    JOIN ${entities} e ON e.stable_id = COALESCE(p.org_entity_id, p.organization_id)
    WHERE e.entity_type = 'organization'
    GROUP BY e.stable_id, e.title
  `);

  const personnelByOrg = new Map(
    personnelRows.map((r) => [r.entity_id, Number(r.total)])
  );

  for (const org of orgEntities) {
    const cnt = personnelByOrg.get(org.stableId) ?? 0;
    const pct = Math.min(100, cnt * 5);
    const missing: string[] = [];
    if (cnt === 0) missing.push("no personnel records");
    else if (cnt < 5) missing.push(`only ${cnt} personnel records — missing broader team`);
    else if (cnt < 15) missing.push(`${cnt} personnel records — deeper coverage needed`);

    rows.push({
      entityId: org.stableId,
      entityName: org.title,
      entityType: "organization",
      recordType: "personnel",
      totalRecords: cnt,
      verifiedRecords: cnt,
      completenessPct: pct,
      missingFields: missing,
    });
  }

  // 3. Funding rounds — per org, binary completeness
  const frRows = await db.execute<{
    entity_id: string;
    total: string;
  }>(sql`
    SELECT
      e.stable_id AS entity_id,
      COUNT(*)::int AS total
    FROM ${fundingRounds} fr
    JOIN ${entities} e ON e.stable_id = COALESCE(fr.company_entity_id, fr.company_id)
    GROUP BY e.stable_id
  `);

  const frByOrg = new Map(frRows.map((r) => [r.entity_id, Number(r.total)]));
  for (const org of orgEntities) {
    const cnt = frByOrg.get(org.stableId) ?? 0;
    const missing: string[] = [];
    if (cnt === 0) missing.push("no funding round data");
    rows.push({
      entityId: org.stableId,
      entityName: org.title,
      entityType: "organization",
      recordType: "funding_rounds",
      totalRecords: cnt,
      verifiedRecords: cnt,
      completenessPct: cnt > 0 ? 100 : 0,
      missingFields: missing,
    });
  }

  // 4. Investments — per org, binary completeness
  const invRows = await db.execute<{
    entity_id: string;
    total: string;
  }>(sql`
    SELECT
      e.stable_id AS entity_id,
      COUNT(*)::int AS total
    FROM ${investments} i
    JOIN ${entities} e ON e.stable_id = COALESCE(i.company_entity_id, i.company_id)
    GROUP BY e.stable_id
  `);

  const invByOrg = new Map(invRows.map((r) => [r.entity_id, Number(r.total)]));
  for (const org of orgEntities) {
    const cnt = invByOrg.get(org.stableId) ?? 0;
    const missing: string[] = [];
    if (cnt === 0) missing.push("no investment records");
    rows.push({
      entityId: org.stableId,
      entityName: org.title,
      entityType: "organization",
      recordType: "investments",
      totalRecords: cnt,
      verifiedRecords: cnt,
      completenessPct: cnt > 0 ? 100 : 0,
      missingFields: missing,
    });
  }

  // 5. Benchmark results — per model, min(100, count * 10)
  const brRows = await db.execute<{
    entity_id: string;
    total: string;
  }>(sql`
    SELECT
      e.stable_id AS entity_id,
      COUNT(*)::int AS total
    FROM ${benchmarkResults} br
    JOIN ${entities} e ON e.stable_id = br.model_id
    GROUP BY e.stable_id
  `);

  const brByModel = new Map(brRows.map((r) => [r.entity_id, Number(r.total)]));
  for (const model of modelEntities) {
    const cnt = brByModel.get(model.stableId) ?? 0;
    const pct = Math.min(100, cnt * 10);
    const missing: string[] = [];
    if (cnt === 0) missing.push("no benchmark results");
    else if (cnt < 5) missing.push(`only ${cnt} benchmark results`);

    rows.push({
      entityId: model.stableId,
      entityName: model.title,
      entityType: "ai-model",
      recordType: "benchmark_results",
      totalRecords: cnt,
      verifiedRecords: cnt,
      completenessPct: pct,
      missingFields: missing,
    });
  }

  // 6. Source quality — unverifiable verdict counts per entity
  const verdictRows = await db.execute<{
    entity_id: string;
    entity_display_name: string | null;
    unverifiable_count: string;
  }>(sql`
    SELECT
      v.entity_id,
      v.entity_display_name,
      COUNT(*)::int AS unverifiable_count
    FROM ${sourceVerdicts} v
    WHERE v.verdict = 'unverifiable' AND v.entity_id IS NOT NULL
    GROUP BY v.entity_id, v.entity_display_name
  `);

  for (const r of verdictRows) {
    if (!r.entity_id) continue;
    const cnt = Number(r.unverifiable_count);
    const pct = Math.max(0, 100 - cnt * 5);
    rows.push({
      entityId: r.entity_id,
      entityName: r.entity_display_name ?? r.entity_id,
      entityType: "organization",
      recordType: "source_quality",
      totalRecords: cnt,
      verifiedRecords: 0,
      completenessPct: pct,
      missingFields: [`${cnt} record(s) with unverifiable sources`],
    });
  }

  return rows;
}

const scannerResultsApp = new Hono()
  // GET /latest — returns the most recent scan run's results
  .get("/latest", zv("query", LatestQuery), async (c) => {
    const { limit, offset, recordType, entityType } = c.req.valid("query");
    const db = getDrizzleDb();

    // Find the most recent scan_run_id
    const latestRun = await db
      .select({ scanRunId: tablebaseScannerResults.scanRunId })
      .from(tablebaseScannerResults)
      .orderBy(desc(tablebaseScannerResults.scannedAt))
      .limit(1);

    if (latestRun.length === 0) {
      return c.json({ items: [], total: 0, scanRunId: null });
    }

    const runId = latestRun[0].scanRunId;

    // Apply optional filters
    const conditions = [eq(tablebaseScannerResults.scanRunId, runId)];
    if (recordType) conditions.push(eq(tablebaseScannerResults.recordType, recordType));
    if (entityType) conditions.push(eq(tablebaseScannerResults.entityType, entityType));

    const combinedWhere = conditions.length === 1
      ? conditions[0]
      : sql`${sql.join(conditions, sql` AND `)}`;

    const [rows, totalRows] = await Promise.all([
      db.select().from(tablebaseScannerResults).where(combinedWhere)
        .orderBy(desc(tablebaseScannerResults.completenessPct))
        .limit(limit).offset(offset),
      db.select({ count: count() }).from(tablebaseScannerResults).where(combinedWhere),
    ]);

    return c.json({
      items: rows.map((r) => formatRow(r as ScannerResultRow)),
      total: totalRows[0]?.count ?? 0,
      scanRunId: runId,
    });
  })
  // GET /trends — scan results grouped by scan_run_id for trend analysis
  .get("/trends", zv("query", TrendsQuery), async (c) => {
    const { entityId, recordType, limit } = c.req.valid("query");
    const db = getDrizzleDb();

    // Get distinct scan runs ordered by recency
    const runsQuery = db
      .select({
        scanRunId: tablebaseScannerResults.scanRunId,
        scannedAt: sql<string>`MIN(${tablebaseScannerResults.scannedAt})`.as("scanned_at"),
        totalItems: count(),
        avgCompleteness: sql<number>`ROUND(AVG(${tablebaseScannerResults.completenessPct})::numeric, 1)`.as("avg_completeness"),
        totalRecordsSum: sql<number>`SUM(${tablebaseScannerResults.totalRecords})`.as("total_records_sum"),
      })
      .from(tablebaseScannerResults)
      .groupBy(tablebaseScannerResults.scanRunId)
      .orderBy(desc(sql`MIN(${tablebaseScannerResults.scannedAt})`))
      .limit(limit);

    const runs = await runsQuery;

    // If entityId or recordType filter is requested, also get per-run details for that filter
    let entityTrends: Array<{ scanRunId: string; completenessPct: number; totalRecords: number; scannedAt: string }> = [];
    if (entityId || recordType) {
      const conditions = [];
      if (entityId) conditions.push(eq(tablebaseScannerResults.entityId, entityId));
      if (recordType) conditions.push(eq(tablebaseScannerResults.recordType, recordType));
      const combinedWhere = conditions.length === 1
        ? conditions[0]
        : sql`${sql.join(conditions, sql` AND `)}`;

      const details = await db
        .select({
          scanRunId: tablebaseScannerResults.scanRunId,
          completenessPct: tablebaseScannerResults.completenessPct,
          totalRecords: tablebaseScannerResults.totalRecords,
          scannedAt: tablebaseScannerResults.scannedAt,
        })
        .from(tablebaseScannerResults)
        .where(combinedWhere)
        .orderBy(desc(tablebaseScannerResults.scannedAt));

      entityTrends = details.map((d) => ({
        scanRunId: d.scanRunId,
        completenessPct: d.completenessPct,
        totalRecords: d.totalRecords,
        scannedAt: d.scannedAt.toISOString(),
      }));
    }

    return c.json({
      runs: runs.map((r) => ({
        scanRunId: r.scanRunId,
        scannedAt: r.scannedAt,
        totalItems: r.totalItems,
        avgCompleteness: r.avgCompleteness,
        totalRecordsSum: r.totalRecordsSum,
      })),
      entityTrends,
    });
  })
  // GET /trends-by-type — per-recordType trend data across scan runs (for sparklines)
  .get("/trends-by-type", zv("query", z.object({ limit: clampedLimit(20, 7) })), async (c) => {
    const { limit } = c.req.valid("query");
    const db = getDrizzleDb();

    // Get the N most recent distinct scan run IDs (same approach as /trends)
    const recentRuns = await db
      .select({
        scanRunId: tablebaseScannerResults.scanRunId,
        scannedAt: sql<string>`MIN(${tablebaseScannerResults.scannedAt})`.as("scanned_at"),
      })
      .from(tablebaseScannerResults)
      .groupBy(tablebaseScannerResults.scanRunId)
      .orderBy(desc(sql`MIN(${tablebaseScannerResults.scannedAt})`))
      .limit(limit);

    if (recentRuns.length === 0) {
      return c.json({ byType: [] });
    }

    const runIds = recentRuns.map((r) => r.scanRunId);

    // Get avg completeness per (recordType, scanRunId) for those runs
    const rows = await db
      .select({
        recordType: tablebaseScannerResults.recordType,
        scanRunId: tablebaseScannerResults.scanRunId,
        scannedAt: sql<string>`MIN(${tablebaseScannerResults.scannedAt})`.as("scanned_at"),
        avgCompleteness: sql<number>`ROUND(AVG(${tablebaseScannerResults.completenessPct})::numeric, 1)`.as("avg_completeness"),
        entityCount: count(),
      })
      .from(tablebaseScannerResults)
      .where(sql`${tablebaseScannerResults.scanRunId} = ANY(${runIds})`)
      .groupBy(tablebaseScannerResults.recordType, tablebaseScannerResults.scanRunId)
      .orderBy(tablebaseScannerResults.recordType, sql`MIN(${tablebaseScannerResults.scannedAt})`);

    // Group by recordType
    const byTypeMap = new Map<string, Array<{ scanRunId: string; scannedAt: string; avgCompleteness: number; entityCount: number }>>();
    for (const row of rows) {
      const existing = byTypeMap.get(row.recordType) ?? [];
      existing.push({
        scanRunId: row.scanRunId,
        scannedAt: row.scannedAt,
        avgCompleteness: row.avgCompleteness,
        entityCount: row.entityCount,
      });
      byTypeMap.set(row.recordType, existing);
    }

    const byType = [...byTypeMap.entries()].map(([recordType, points]) => ({
      recordType,
      points,
    }));

    return c.json({ byType });
  })
  // POST /run — run a server-side scan, compute coverage via SQL, persist results
  .post("/run", async (c) => {
    const db = getDrizzleDb();
    const scanRunId = randomUUID();
    const now = new Date();

    const scanRows = await runServerSideScan();

    if (scanRows.length === 0) {
      return c.json({ scanRunId, inserted: 0, tables: 0, message: "No entities found" });
    }

    const CHUNK_SIZE = 500;
    // Wrap all chunks in one transaction so a mid-run failure doesn't leave a
    // partial scanRunId visible to /latest.
    const inserted = await db.transaction(async (tx) => {
      let total = 0;
      for (let i = 0; i < scanRows.length; i += CHUNK_SIZE) {
        const chunk = scanRows.slice(i, i + CHUNK_SIZE);
        await tx.insert(tablebaseScannerResults).values(
          chunk.map((row) => ({
            scanRunId,
            recordType: row.recordType,
            entityId: row.entityId,
            entityName: row.entityName,
            entityType: row.entityType,
            totalRecords: row.totalRecords,
            verifiedRecords: row.verifiedRecords,
            completenessPct: row.completenessPct,
            missingFields: row.missingFields,
            entityImportance: null,
            scannedAt: now,
          })),
        );
        total += chunk.length;
      }
      return total;
    });

    const recordTypes = [...new Set(scanRows.map((r) => r.recordType))];
    const avgCompleteness = scanRows.length > 0
      ? Math.round(scanRows.reduce((s, r) => s + r.completenessPct, 0) / scanRows.length * 10) / 10
      : 0;

    return c.json({
      scanRunId,
      inserted,
      tables: recordTypes.length,
      recordTypes,
      avgCompleteness,
      scannedAt: now.toISOString(),
    });
  })
  // POST /sync — accepts batch scan results and upserts them
  .post("/sync", zv("json", SyncBatchSchema), async (c) => {
    const { items } = c.req.valid("json");
    const db = getDrizzleDb();
    const now = new Date();

    // Validate entity FK references
    const refError = await validateEntityRefs(c, db, [
      { fieldName: "entityId", ids: items.map((i) => i.entityId) },
    ]);
    if (refError) return refError;

    const rows = items.map((item: SyncItem) => ({
      scanRunId: item.scanRunId,
      recordType: item.recordType,
      entityId: item.entityId,
      entityName: item.entityName,
      entityType: item.entityType,
      totalRecords: item.totalRecords,
      verifiedRecords: item.verifiedRecords,
      completenessPct: item.completenessPct,
      missingFields: item.missingFields,
      entityImportance: item.entityImportance ?? null,
      scannedAt: item.scannedAt ? new Date(item.scannedAt) : now,
    }));

    // Insert in chunks to avoid exceeding PG parameter limit
    const CHUNK_SIZE = 500;
    let inserted = 0;
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      await db.insert(tablebaseScannerResults).values(chunk);
      inserted += chunk.length;
    }

    return c.json({ upserted: inserted });
  })
  // POST /delete-batch — standard delete handler
  .post("/delete-batch", deleteBatchHandler(tablebaseScannerResults, null));

export const scannerResultsRoute = scannerResultsApp;
export type ScannerResultsRoute = typeof scannerResultsApp;
