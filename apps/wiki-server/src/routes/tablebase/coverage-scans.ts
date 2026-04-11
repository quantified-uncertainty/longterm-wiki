import { Hono } from "hono";
import { z } from "zod";
import { eq, desc, count } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { tablebaseCoverageScans } from "../../schema.js";
import { zv, clampedLimit } from "../shared/utils.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { createSyncHandler } from "./sync-factory.js";

const MAX_PAGE_SIZE = 500;
const MAX_BATCH_SIZE = 2000;

const ListQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 200),
  offset: z.coerce.number().int().min(0).default(0),
  entityType: z.string().max(100).optional(),
});

const SyncItemSchema = z.object({
  id: z.string().optional(), // Satisfies factory TItem constraint; not stored — entityId is the natural key
  entityType: z.string().min(1).max(100),
  entityId: z.string().min(1).max(200),
  coverageScore: z.number().int().min(1).max(4),
  signalsFilled: z.number().int().min(0).default(0),
  signalsTotal: z.number().int().min(0).default(0),
  signals: z.record(z.boolean()).default({}),
  scannedAt: z.string().datetime().optional(),
});

const SyncBatchSchema = z.object({
  items: z.array(SyncItemSchema).min(1).max(MAX_BATCH_SIZE),
});

type SyncItem = z.infer<typeof SyncItemSchema>;

interface CoverageScanRow {
  id: number;
  entityType: string;
  entityId: string;
  coverageScore: number;
  signalsFilled: number;
  signalsTotal: number;
  signals: unknown;
  scannedAt: Date;
}

function formatRow(r: CoverageScanRow) {
  return {
    id: r.id, entityType: r.entityType, entityId: r.entityId,
    coverageScore: r.coverageScore, signalsFilled: r.signalsFilled,
    signalsTotal: r.signalsTotal, signals: r.signals,
    scannedAt: r.scannedAt.toISOString(),
  };
}

const coverageScansApp = new Hono()
  .get("/all", zv("query", ListQuery), async (c) => {
    const { limit, offset, entityType } = c.req.valid("query");
    const db = getDrizzleDb();
    const where = entityType ? eq(tablebaseCoverageScans.entityType, entityType) : undefined;
    const [rows, totalRows] = await Promise.all([
      db.select().from(tablebaseCoverageScans).where(where)
        .orderBy(desc(tablebaseCoverageScans.scannedAt)).limit(limit).offset(offset),
      db.select({ count: count() }).from(tablebaseCoverageScans).where(where),
    ]);
    return c.json({ items: rows.map((r) => formatRow(r as CoverageScanRow)), total: totalRows[0]?.count ?? 0 });
  })
  .get("/stats", async (c) => {
    const db = getDrizzleDb();
    const rows = await db
      .select({ entityType: tablebaseCoverageScans.entityType, coverageScore: tablebaseCoverageScans.coverageScore, count: count() })
      .from(tablebaseCoverageScans)
      .groupBy(tablebaseCoverageScans.entityType, tablebaseCoverageScans.coverageScore);
    return c.json({ stats: rows });
  })
  .post(
    "/sync",
    createSyncHandler<SyncItem, typeof tablebaseCoverageScans>({
      name: "coverage-scans",
      table: tablebaseCoverageScans,
      batchSchema: SyncBatchSchema as z.ZodType<{ items: SyncItem[] }>,
      toRow: (item, now) => ({
        entityType: item.entityType,
        entityId: item.entityId,
        coverageScore: item.coverageScore,
        signalsFilled: item.signalsFilled,
        signalsTotal: item.signalsTotal,
        signals: item.signals,
        scannedAt: item.scannedAt ? new Date(item.scannedAt) : now,
        updatedAt: now,
      }),
      conflictTarget: tablebaseCoverageScans.entityId,
      naturalKey: (item) => item.entityId,
      naturalKeyError: "Duplicate entityId in batch",
      entityRefFields: (items) => [
        { fieldName: "entityId", ids: items.map((i) => i.entityId) },
      ],
    }),
  )
  .post("/delete-batch", deleteBatchHandler(tablebaseCoverageScans, null));

export const coverageScansRoute = coverageScansApp;
export type CoverageScansRoute = typeof coverageScansApp;
