/**
 * framework_ingest_log (QUA-711 Phase 4-D).
 *
 * Append-only audit trail for the weekly framework re-fetch job. One row
 * per (framework_id, fetched_at) — captures the classifyIngest verdict
 * plus the fresh hash and free-form note. Powers two things:
 *
 *   1. **Latest-known-hash lookup** — `classifyIngest()` compares the
 *      fresh hash against the most recent log entry (any status) for that
 *      framework. New rows do nothing on `unchanged`; on
 *      `silent_update_detected` they trigger a Discord webhook (handled
 *      by the caller).
 *   2. **Audit history** — visible from the
 *      `/internal/framework-review` dashboard so reviewers can see when a
 *      lab silently edited a published page and what hash drift produced
 *      the alert.
 *
 * Insert-only: no /sync (idempotent UPSERT doesn't fit a log) and no
 * /delete-batch. Rows are minted with deterministic IDs by the caller so
 * a re-run with identical state can detect prior insertion via 409.
 */

import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, desc } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { frameworkIngestLog } from "../../schema.js";
import { zv, clampedLimit, notFoundError } from "../shared/utils.js";
import { paginatedQuery } from "../shared/paginated-query.js";

const MAX_PAGE_SIZE = 500;

const VALID_STATUS = [
  "new_version",
  "unchanged",
  "silent_update_detected",
  "fetch_failed",
] as const;

const AllQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 100),
  offset: z.coerce.number().int().min(0).default(0),
  framework_id: z.string().max(200).optional(),
  status: z.enum(VALID_STATUS).optional(),
});

const InsertItemSchema = z.object({
  id: z
    .string()
    .regex(
      /^[A-Za-z0-9_-]{10}$/,
      "id must be 10 alphanumeric characters (hyphens and underscores allowed)",
    ),
  frameworkId: z.string().min(1).max(200),
  sourceUrl: z.string().min(1).max(2000),
  contentHash: z.string().max(200).nullable().optional(),
  status: z.enum(VALID_STATUS),
  notes: z.string().max(2000).nullable().optional(),
});

const InsertBatchSchema = z.object({
  items: z.array(InsertItemSchema).min(1).max(100),
});

const ingestLogApp = new Hono()

  .get("/all", zv("query", AllQuery), async (c) => {
    const { limit, offset, framework_id, status } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions: SQL[] = [];
    if (framework_id)
      conditions.push(eq(frameworkIngestLog.frameworkId, framework_id));
    if (status) conditions.push(eq(frameworkIngestLog.status, status));

    const where =
      conditions.length === 0
        ? undefined
        : conditions.length === 1
          ? conditions[0]
          : and(...conditions);

    const { rows, total } = await paginatedQuery({
      query: db
        .select()
        .from(frameworkIngestLog)
        .where(where)
        .orderBy(desc(frameworkIngestLog.fetchedAt))
        .limit(limit)
        .offset(offset),
      countQuery: db
        .select({ count: count() })
        .from(frameworkIngestLog)
        .where(where),
      formatRow: (r: typeof frameworkIngestLog.$inferSelect) => r,
    });

    return c.json({ items: rows, total, limit, offset });
  })

  .get("/by-framework/:frameworkId", zv("query", AllQuery), async (c) => {
    const frameworkId = c.req.param("frameworkId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const where = eq(frameworkIngestLog.frameworkId, frameworkId);
    const { rows, total } = await paginatedQuery({
      query: db
        .select()
        .from(frameworkIngestLog)
        .where(where)
        .orderBy(desc(frameworkIngestLog.fetchedAt))
        .limit(limit)
        .offset(offset),
      countQuery: db
        .select({ count: count() })
        .from(frameworkIngestLog)
        .where(where),
      formatRow: (r: typeof frameworkIngestLog.$inferSelect) => r,
    });

    return c.json({ frameworkId, items: rows, total, limit, offset });
  })

  /**
   * Latest log entry per framework. Used by the re-fetch script to
   * identify the most recent known content hash for `classifyIngest()`.
   */
  .get("/latest/:frameworkId", async (c) => {
    const frameworkId = c.req.param("frameworkId");
    const db = getDrizzleDb();
    const rows = await db
      .select()
      .from(frameworkIngestLog)
      .where(eq(frameworkIngestLog.frameworkId, frameworkId))
      .orderBy(desc(frameworkIngestLog.fetchedAt))
      .limit(1);

    if (rows.length === 0) {
      return notFoundError(c, `No log entries for framework ${frameworkId}`);
    }
    return c.json(rows[0]);
  })

  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const db = getDrizzleDb();
    const rows = await db
      .select()
      .from(frameworkIngestLog)
      .where(eq(frameworkIngestLog.id, id))
      .limit(1);

    if (rows.length === 0) {
      return notFoundError(c, `Framework ingest log ${id} not found`);
    }
    return c.json(rows[0]);
  })

  /**
   * Append-only insert. Failing on duplicate id is the dedup signal — the
   * caller passes a deterministic id derived from
   * (framework_id, content_hash, fetched_at_minute) so a stuck run
   * retrying within the same minute doesn't double-insert. Different
   * runs at different times produce different ids and stack normally.
   */
  .post("/insert", zv("json", InsertBatchSchema), async (c) => {
    const { items } = c.req.valid("json");
    const db = getDrizzleDb();
    const now = new Date();
    const rows = items.map((item) => ({
      ...item,
      contentHash: item.contentHash ?? null,
      notes: item.notes ?? null,
      fetchedAt: now,
      createdAt: now,
    }));

    const inserted = await db
      .insert(frameworkIngestLog)
      .values(rows)
      .onConflictDoNothing({ target: frameworkIngestLog.id })
      .returning({ id: frameworkIngestLog.id });

    return c.json({ inserted: inserted.length, requested: items.length });
  });

export const frameworkIngestLogRoute = ingestLogApp;
export type FrameworkIngestLogRoute = typeof ingestLogApp;
