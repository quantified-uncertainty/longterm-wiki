/**
 * safety_framework_versions (QUA-691 Phase 4).
 *
 * One row per published framework version. Natural key on
 * (framework_id, content_hash) — silent lab edits become new rows
 * documenting drift rather than overwriting previously-extracted data.
 */

import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, desc, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { safetyFrameworkVersions } from "../../schema.js";
import {
  zv,
  clampedLimit,
  noDuplicateIds,
  notFoundError,
} from "../shared/utils.js";
import { paginatedQuery } from "../shared/paginated-query.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { createSyncHandler } from "./sync-factory.js";

const MAX_PAGE_SIZE = 500;

const VALID_INGEST_STATUS = ["pending_review", "published", "rejected"] as const;

const AllQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 200),
  offset: z.coerce.number().int().min(0).default(0),
  framework_id: z.string().max(200).optional(),
  ingest_status: z.enum(VALID_INGEST_STATUS).optional(),
});

const SyncItemSchema = z.object({
  id: z.string().regex(
    /^[A-Za-z0-9_-]{10}$/,
    "id must be 10 alphanumeric characters (hyphens and underscores allowed)",
  ),
  frameworkId: z.string().min(1).max(200),
  versionLabel: z.string().min(1).max(100),
  versionSortOrder: z.number().int(),
  publishedDate: z.string().max(20).nullable().optional(),
  discoveredDate: z.string().max(20),
  sourceUrl: z.string().min(1).max(2000),
  sourceUrlCanonical: z.string().max(2000).nullable().optional(),
  waybackSnapshotUrl: z.string().max(2000).nullable().optional(),
  pdfArchiveUrl: z.string().max(2000).nullable().optional(),
  contentHash: z.string().min(1).max(200),
  contentLengthChars: z.number().int().nonnegative().nullable().optional(),
  summary: z.string().max(5000).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  isDraft: z.boolean().optional(),
  supersededByVersionId: z.string().max(200).nullable().optional(),
  ingestStatus: z.enum(VALID_INGEST_STATUS).optional(),
});

const SyncBatchSchema = z.object({
  items: z
    .array(SyncItemSchema)
    .min(1)
    .max(500)
    .refine(noDuplicateIds, { message: "Duplicate id values in items array" }),
});

const versionsApp = new Hono()

  .get("/stats", async (c) => {
    const db = getDrizzleDb();
    const [row] = await db
      .select({
        total: count(),
        frameworks: sql<number>`count(distinct ${safetyFrameworkVersions.frameworkId})`,
        published: sql<number>`count(*) filter (where ${safetyFrameworkVersions.ingestStatus} = 'published')`,
        pending: sql<number>`count(*) filter (where ${safetyFrameworkVersions.ingestStatus} = 'pending_review')`,
      })
      .from(safetyFrameworkVersions);

    return c.json({
      total: row.total,
      frameworks: Number(row.frameworks),
      published: Number(row.published),
      pending: Number(row.pending),
    });
  })

  .get("/all", zv("query", AllQuery), async (c) => {
    const { limit, offset, framework_id, ingest_status } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions: SQL[] = [];
    if (framework_id) conditions.push(eq(safetyFrameworkVersions.frameworkId, framework_id));
    if (ingest_status) conditions.push(eq(safetyFrameworkVersions.ingestStatus, ingest_status));

    const where =
      conditions.length === 0
        ? undefined
        : conditions.length === 1
          ? conditions[0]
          : and(...conditions);

    const { rows, total } = await paginatedQuery({
      query: db
        .select()
        .from(safetyFrameworkVersions)
        .where(where)
        .orderBy(
          desc(safetyFrameworkVersions.frameworkId),
          desc(safetyFrameworkVersions.versionSortOrder),
        )
        .limit(limit)
        .offset(offset),
      countQuery: db
        .select({ count: count() })
        .from(safetyFrameworkVersions)
        .where(where),
      formatRow: (r: typeof safetyFrameworkVersions.$inferSelect) => r,
    });

    return c.json({ items: rows, total, limit, offset });
  })

  .get("/by-framework/:frameworkId", zv("query", AllQuery), async (c) => {
    const frameworkId = c.req.param("frameworkId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const where = eq(safetyFrameworkVersions.frameworkId, frameworkId);
    const { rows, total } = await paginatedQuery({
      query: db
        .select()
        .from(safetyFrameworkVersions)
        .where(where)
        .orderBy(desc(safetyFrameworkVersions.versionSortOrder))
        .limit(limit)
        .offset(offset),
      countQuery: db
        .select({ count: count() })
        .from(safetyFrameworkVersions)
        .where(where),
      formatRow: (r: typeof safetyFrameworkVersions.$inferSelect) => r,
    });

    return c.json({ frameworkId, items: rows, total, limit, offset });
  })

  .get("/by-entity/:entityId", zv("query", AllQuery), async (c) => {
    // Versions don't reference an entity directly; return empty to satisfy
    // the factory convention check. Callers should use /by-framework.
    return c.json({
      entityId: c.req.param("entityId"),
      items: [],
      total: 0,
      limit: 0,
      offset: 0,
    });
  })

  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const db = getDrizzleDb();
    const rows = await db
      .select()
      .from(safetyFrameworkVersions)
      .where(eq(safetyFrameworkVersions.id, id))
      .limit(1);

    if (rows.length === 0) {
      return notFoundError(c, `Safety framework version ${id} not found`);
    }
    return c.json(rows[0]);
  })

  .post(
    "/sync",
    createSyncHandler({
      name: "safety-framework-versions",
      table: safetyFrameworkVersions,
      batchSchema: SyncBatchSchema,
      naturalKey: (item) => `${item.frameworkId}|${item.contentHash}`,
      toRow: (item, now) => ({
        ...item,
        isDraft: item.isDraft ?? false,
        ingestStatus: item.ingestStatus ?? "pending_review",
        syncedAt: now,
        updatedAt: now,
      }),
      conflictSet: {
        frameworkId: sql`excluded.framework_id`,
        versionLabel: sql`excluded.version_label`,
        versionSortOrder: sql`excluded.version_sort_order`,
        publishedDate: sql`COALESCE(excluded.published_date, ${safetyFrameworkVersions.publishedDate})`,
        discoveredDate: sql`excluded.discovered_date`,
        sourceUrl: sql`excluded.source_url`,
        sourceUrlCanonical: sql`COALESCE(excluded.source_url_canonical, ${safetyFrameworkVersions.sourceUrlCanonical})`,
        waybackSnapshotUrl: sql`COALESCE(excluded.wayback_snapshot_url, ${safetyFrameworkVersions.waybackSnapshotUrl})`,
        pdfArchiveUrl: sql`COALESCE(excluded.pdf_archive_url, ${safetyFrameworkVersions.pdfArchiveUrl})`,
        contentHash: sql`excluded.content_hash`,
        contentLengthChars: sql`COALESCE(excluded.content_length_chars, ${safetyFrameworkVersions.contentLengthChars})`,
        summary: sql`COALESCE(excluded.summary, ${safetyFrameworkVersions.summary})`,
        notes: sql`COALESCE(excluded.notes, ${safetyFrameworkVersions.notes})`,
        isDraft: sql`excluded.is_draft`,
        supersededByVersionId: sql`COALESCE(excluded.superseded_by_version_id, ${safetyFrameworkVersions.supersededByVersionId})`,
        ingestStatus: sql`excluded.ingest_status`,
        syncedAt: sql`now()`,
        updatedAt: sql`now()`,
      },
      auditRecordType: "safety_framework_versions",
      toThing: (item) => ({
        id: item.id,
        thingType: "safety-framework-version" as const,
        parentThingId: item.frameworkId,
        sourceTable: "safety_framework_versions",
        sourceId: item.id,
        sourceUrl: item.sourceUrl,
      }),
    }),
  )

  .post("/delete-batch", deleteBatchHandler(safetyFrameworkVersions, "safety_framework_versions"));

export const safetyFrameworkVersionsRoute = versionsApp;
export type SafetyFrameworkVersionsRoute = typeof versionsApp;
