import { Hono } from "hono";
import { z } from "zod";
import { eq, desc, count, sql } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { tablebaseScannerResults } from "../../schema.js";
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
