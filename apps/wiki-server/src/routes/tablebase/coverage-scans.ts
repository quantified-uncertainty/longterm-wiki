import { Hono } from "hono";
import { z } from "zod";
import { eq, desc, count, sql } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { tablebaseCoverageScans } from "../../schema.js";
import { zv, clampedLimit, parseJsonBody, validationError, invalidJsonError } from "../shared/utils.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { logger } from "../../logger.js";

const MAX_PAGE_SIZE = 500;
const MAX_BATCH_SIZE = 2000;

const ListQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 200),
  offset: z.coerce.number().int().min(0).default(0),
  entityType: z.string().max(100).optional(),
});

const SyncItemSchema = z.object({
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

// Hand-rolled sync handler because this table uses entityId as the upsert
// key, not a standard `id` PK (factory requires { id?: string } items).
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
  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);
    const parsed = SyncBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.errors.map((e) => e.message).join("; "));
    const { items } = parsed.data;
    const now = new Date();
    const db = getDrizzleDb();
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.entityId)) return validationError(c, `Duplicate entityId in batch: ${item.entityId}`);
      seen.add(item.entityId);
    }
    const rows = items.map((item) => ({
      entityType: item.entityType, entityId: item.entityId,
      coverageScore: item.coverageScore, signalsFilled: item.signalsFilled,
      signalsTotal: item.signalsTotal, signals: item.signals,
      scannedAt: item.scannedAt ? new Date(item.scannedAt) : now, updatedAt: now,
    }));
    await db.insert(tablebaseCoverageScans).values(rows).onConflictDoUpdate({
      target: tablebaseCoverageScans.entityId,
      set: {
        entityType: sql`excluded.entity_type`, coverageScore: sql`excluded.coverage_score`,
        signalsFilled: sql`excluded.signals_filled`, signalsTotal: sql`excluded.signals_total`,
        signals: sql`excluded.signals`, scannedAt: sql`excluded.scanned_at`, updatedAt: sql`excluded.updated_at`,
      },
    });
    logger.info({ count: items.length }, "coverage-scans: synced");
    return c.json({ upserted: items.length });
  })
  .post("/delete-batch", deleteBatchHandler(tablebaseCoverageScans, "coverage_scans"));

export const coverageScansRoute = coverageScansApp;
export type CoverageScansRoute = typeof coverageScansApp;
