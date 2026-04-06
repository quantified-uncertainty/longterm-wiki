/**
 * Data Sources API — CRUD for data sources (tabular import pipelines).
 *
 * During transition (PR 3/5 of Discussion #3567), this route dual-writes to
 * both old tables (data_sources, source_snapshots) and new tables (resources,
 * resource_tabular_sources). Reads still use the old tables for guaranteed
 * data availability, enriched with resourceId from the new tables.
 *
 * Hono RPC method-chained route for type inference.
 */

import { Hono } from "hono";
import { z } from "zod";
import { eq, desc, and, count, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { getDrizzleDb } from "../../db.js";
import { dataSources, sourceSnapshots, resources, resourceTabularSources } from "../../schema.js";
import { paginationQuery, zv, notFoundError } from "../shared/utils.js";
import { logger } from "../../logger.js";

// ---- Zod schemas ----

const VALID_DATA_FORMATS = ["csv", "html_table", "json_api", "spreadsheet"] as const;
const VALID_ACCESS_METHODS = ["direct_download", "api_endpoint", "web_scrape", "manual_export"] as const;
const VALID_RECORD_TYPES = ["grant", "personnel", "investment", "publication", "mixed"] as const;
const VALID_UPDATE_FREQUENCIES = ["static", "weekly", "monthly", "quarterly", "annual"] as const;
const VALID_SOURCE_STATUSES = ["active", "archived", "defunct"] as const;

const SyncDataSourceSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(500),
  dataFormat: z.enum(VALID_DATA_FORMATS),
  accessMethod: z.enum(VALID_ACCESS_METHODS),
  recordType: z.enum(VALID_RECORD_TYPES),
  fetchUrl: z.string().max(2000).nullable().optional(),
  resourceId: z.string().max(100).nullable().optional(),
  publisherEntityId: z.string().max(100).nullable().optional(),
  updateFrequency: z.enum(VALID_UPDATE_FREQUENCIES).nullable().optional(),
  columnMapping: z.record(z.string()).nullable().optional(),
  sourceSchema: z.record(z.unknown()).nullable().optional(),
  verificationConfig: z.record(z.unknown()).nullable().optional(),
  sourceStatus: z.enum(VALID_SOURCE_STATUSES).optional(),
});

const CreateSnapshotSchema = z.object({
  snapshotHash: z.string().min(1).max(128),
  recordCount: z.number().int().min(0).nullable().optional(),
  rawContent: z.string().min(1).max(50_000_000).transform(s => s.replace(/\0/g, '')),
  fetchedAt: z.string().datetime().optional(),
  mappingValid: z.boolean().optional(),
  parserVersion: z.string().max(100).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const SnapshotListQuery = paginationQuery({ defaultLimit: 20, maxLimit: 100 });

// ---- Helpers ----

/** Replicate the hashId() used for resource IDs: SHA-256, first 16 hex chars. */
function hashId(str: string): string {
  return createHash("sha256").update(str).digest("hex").slice(0, 16);
}

function formatDataSource(r: typeof dataSources.$inferSelect, resourceId?: string | null) {
  return {
    id: r.id,
    name: r.name,
    dataFormat: r.dataFormat,
    accessMethod: r.accessMethod,
    recordType: r.recordType,
    fetchUrl: r.fetchUrl,
    resourceId: resourceId ?? r.resourceId,
    publisherEntityId: r.publisherEntityId,
    updateFrequency: r.updateFrequency,
    columnMapping: r.columnMapping,
    sourceSchema: r.sourceSchema,
    verificationConfig: r.verificationConfig,
    lastSnapshotAt: r.lastSnapshotAt?.toISOString() ?? null,
    snapshotRecordCount: r.snapshotRecordCount,
    latestSnapshotHash: r.latestSnapshotHash,
    sourceStatus: r.sourceStatus,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// ---- Route ----

const dataSourcesApp = new Hono()

  // GET / — list all data sources (enriched with resourceId from new tables)
  .get("/", async (c) => {
    const db = getDrizzleDb();
    const rows = await db
      .select({
        ds: dataSources,
        resourceId: resourceTabularSources.resourceId,
      })
      .from(dataSources)
      .leftJoin(resourceTabularSources, eq(resourceTabularSources.sourceSlug, dataSources.id))
      .orderBy(dataSources.name);
    return c.json({ dataSources: rows.map((r) => formatDataSource(r.ds, r.resourceId)) });
  })

  // GET /:id — single data source with latest snapshot metadata
  .get("/:id", async (c) => {
    const db = getDrizzleDb();
    const id = c.req.param("id");

    // Try old table first (slug lookup), enriched with new table resourceId
    const [row] = await db
      .select({
        ds: dataSources,
        resourceId: resourceTabularSources.resourceId,
      })
      .from(dataSources)
      .leftJoin(resourceTabularSources, eq(resourceTabularSources.sourceSlug, dataSources.id))
      .where(eq(dataSources.id, id));

    if (!row) return notFoundError(c, "Data source not found");

    // Get latest snapshot metadata (without raw_content)
    const [latestSnapshot] = await db
      .select({
        id: sourceSnapshots.id,
        snapshotHash: sourceSnapshots.snapshotHash,
        recordCount: sourceSnapshots.recordCount,
        fetchedAt: sourceSnapshots.fetchedAt,
        mappingValid: sourceSnapshots.mappingValid,
        parserVersion: sourceSnapshots.parserVersion,
        notes: sourceSnapshots.notes,
        createdAt: sourceSnapshots.createdAt,
      })
      .from(sourceSnapshots)
      .where(eq(sourceSnapshots.dataSourceId, id))
      .orderBy(desc(sourceSnapshots.fetchedAt))
      .limit(1);

    return c.json({
      ...formatDataSource(row.ds, row.resourceId),
      latestSnapshot: latestSnapshot
        ? {
            id: latestSnapshot.id,
            snapshotHash: latestSnapshot.snapshotHash,
            recordCount: latestSnapshot.recordCount,
            fetchedAt: latestSnapshot.fetchedAt.toISOString(),
            mappingValid: latestSnapshot.mappingValid,
            parserVersion: latestSnapshot.parserVersion,
            notes: latestSnapshot.notes,
            createdAt: latestSnapshot.createdAt.toISOString(),
          }
        : null,
    });
  })

  // POST /sync — upsert a data source (dual-write to old + new tables)
  .post("/sync", zv("json", SyncDataSourceSchema), async (c) => {
    const db = getDrizzleDb();
    const body = c.req.valid("json");

    // 1. Write to old data_sources table (primary, maintains backward compat)
    await db
      .insert(dataSources)
      .values({
        id: body.id,
        name: body.name,
        dataFormat: body.dataFormat,
        accessMethod: body.accessMethod,
        recordType: body.recordType,
        fetchUrl: body.fetchUrl ?? null,
        resourceId: body.resourceId ?? null,
        publisherEntityId: body.publisherEntityId ?? null,
        updateFrequency: body.updateFrequency ?? null,
        columnMapping: body.columnMapping ?? null,
        sourceSchema: body.sourceSchema ?? null,
        verificationConfig: body.verificationConfig ?? null,
        sourceStatus: body.sourceStatus ?? "active",
      })
      .onConflictDoUpdate({
        target: dataSources.id,
        set: {
          name: body.name,
          dataFormat: body.dataFormat,
          accessMethod: body.accessMethod,
          recordType: body.recordType,
          fetchUrl: body.fetchUrl ?? null,
          resourceId: body.resourceId ?? null,
          publisherEntityId: body.publisherEntityId ?? null,
          updateFrequency: body.updateFrequency ?? null,
          columnMapping: body.columnMapping ?? null,
          sourceSchema: body.sourceSchema ?? null,
          verificationConfig: body.verificationConfig ?? null,
          ...(body.sourceStatus !== undefined ? { sourceStatus: body.sourceStatus } : {}),
          updatedAt: new Date(),
        },
      });

    // 2. Dual-write to new tables (best-effort — don't fail the sync).
    // Wrapped in a transaction so we don't get orphaned resource rows.
    const url = body.fetchUrl ?? `urn:lw:tabular-source:${body.id}`;
    const resId = hashId(url);
    let actualResId = resId;

    try {
      await db.transaction(async (tx) => {
        // Upsert resource row. ON CONFLICT on URL handles the case where
        // a resource was created by resource-ingest with a different ID scheme.
        const [upsertedResource] = await tx
          .insert(resources)
          .values({
            id: resId,
            url,
            title: body.name,
            type: "dataset",
            resourceSubtype: "tabular_source",
            publisherEntityId: body.publisherEntityId ?? null,
          })
          .onConflictDoUpdate({
            target: resources.url,
            set: {
              title: body.name,
              resourceSubtype: "tabular_source",
              publisherEntityId: body.publisherEntityId ?? null,
              updatedAt: new Date(),
            },
          })
          .returning({ id: resources.id });

        actualResId = upsertedResource.id;

        // Upsert resource_tabular_sources. Conflict on sourceSlug (not resourceId)
        // so that changing a source's URL correctly updates the resourceId.
        await tx
          .insert(resourceTabularSources)
          .values({
            resourceId: actualResId,
            sourceSlug: body.id,
            dataFormat: body.dataFormat,
            accessMethod: body.accessMethod,
            recordType: body.recordType,
            updateFrequency: body.updateFrequency ?? null,
            columnMapping: body.columnMapping ?? null,
            sourceSchema: body.sourceSchema ?? null,
            verificationConfig: body.verificationConfig ?? null,
            sourceStatus: body.sourceStatus ?? "active",
          })
          .onConflictDoUpdate({
            target: resourceTabularSources.sourceSlug,
            set: {
              resourceId: actualResId,
              dataFormat: body.dataFormat,
              accessMethod: body.accessMethod,
              recordType: body.recordType,
              updateFrequency: body.updateFrequency ?? null,
              columnMapping: body.columnMapping ?? null,
              sourceSchema: body.sourceSchema ?? null,
              verificationConfig: body.verificationConfig ?? null,
              ...(body.sourceStatus !== undefined ? { sourceStatus: body.sourceStatus } : {}),
              updatedAt: new Date(),
            },
          });
      });
    } catch (e: unknown) {
      // Best-effort: don't fail the sync if new table writes fail.
      // actualResId falls back to the computed hash.
      logger.warn({
        error: e instanceof Error ? e.message : String(e),
        slug: body.id,
        resourceId: resId,
      }, "Failed to dual-write to resource_tabular_sources");
    }

    return c.json({ ok: true, id: body.id, resourceId: actualResId });
  })

  // GET /:id/snapshots — list snapshots (paginated, most recent first)
  .get("/:id/snapshots", zv("query", SnapshotListQuery), async (c) => {
    const db = getDrizzleDb();
    const id = c.req.param("id");
    const { limit, offset } = c.req.valid("query");

    const [totalRow] = await db
      .select({ count: count() })
      .from(sourceSnapshots)
      .where(eq(sourceSnapshots.dataSourceId, id));
    const total = totalRow?.count ?? 0;

    const rows = await db
      .select({
        id: sourceSnapshots.id,
        dataSourceId: sourceSnapshots.dataSourceId,
        snapshotHash: sourceSnapshots.snapshotHash,
        recordCount: sourceSnapshots.recordCount,
        fetchedAt: sourceSnapshots.fetchedAt,
        mappingValid: sourceSnapshots.mappingValid,
        parserVersion: sourceSnapshots.parserVersion,
        notes: sourceSnapshots.notes,
        createdAt: sourceSnapshots.createdAt,
      })
      .from(sourceSnapshots)
      .where(eq(sourceSnapshots.dataSourceId, id))
      .orderBy(desc(sourceSnapshots.fetchedAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      snapshots: rows.map((r) => ({
        id: r.id,
        dataSourceId: r.dataSourceId,
        snapshotHash: r.snapshotHash,
        recordCount: r.recordCount,
        fetchedAt: r.fetchedAt.toISOString(),
        mappingValid: r.mappingValid,
        parserVersion: r.parserVersion,
        notes: r.notes,
        createdAt: r.createdAt.toISOString(),
      })),
      total,
    });
  })

  // POST /:id/snapshots — create a snapshot (content-hash dedup)
  .post("/:id/snapshots", zv("json", CreateSnapshotSchema), async (c) => {
    const db = getDrizzleDb();
    const dataSourceId = c.req.param("id");
    const body = c.req.valid("json");

    // Verify data source exists
    const [ds] = await db.select({ id: dataSources.id }).from(dataSources).where(eq(dataSources.id, dataSourceId));
    if (!ds) return notFoundError(c, "Data source not found");

    // Atomic INSERT ... ON CONFLICT DO NOTHING to avoid race conditions.
    // Large snapshots (16-40MB raw_content) can exceed the default 30s
    // statement_timeout, so we raise it for this transaction.
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '120000'`);

      // Resolve resourceId inside the transaction to avoid TOCTOU race
      const [rts] = await tx
        .select({ resourceId: resourceTabularSources.resourceId })
        .from(resourceTabularSources)
        .where(eq(resourceTabularSources.sourceSlug, dataSourceId));

      const [inserted] = await tx
        .insert(sourceSnapshots)
        .values({
          dataSourceId,
          resourceId: rts?.resourceId ?? null,
          snapshotHash: body.snapshotHash,
          recordCount: body.recordCount ?? null,
          rawContent: body.rawContent,
          fetchedAt: body.fetchedAt ? new Date(body.fetchedAt) : new Date(),
          mappingValid: body.mappingValid ?? true,
          parserVersion: body.parserVersion ?? null,
          notes: body.notes ?? null,
        })
        .onConflictDoNothing({ target: [sourceSnapshots.dataSourceId, sourceSnapshots.snapshotHash] })
        .returning({ id: sourceSnapshots.id });

      if (!inserted) {
        // Content-hash dedup: this exact content already exists
        const [existing] = await tx
          .select({ id: sourceSnapshots.id })
          .from(sourceSnapshots)
          .where(and(
            eq(sourceSnapshots.dataSourceId, dataSourceId),
            eq(sourceSnapshots.snapshotHash, body.snapshotHash),
          ));
        return { id: existing?.id ?? 0, deduplicated: true } as const;
      }

      // Only advance latest-snapshot metadata when the incoming snapshot
      // is newer than what's stored.
      const snapshotFetchedAt = body.fetchedAt ? new Date(body.fetchedAt) : new Date();
      const [current] = await tx
        .select({ lastSnapshotAt: dataSources.lastSnapshotAt })
        .from(dataSources)
        .where(eq(dataSources.id, dataSourceId));

      const shouldAdvanceLatest =
        !current?.lastSnapshotAt || snapshotFetchedAt >= current.lastSnapshotAt;

      await tx
        .update(dataSources)
        .set({
          ...(shouldAdvanceLatest
            ? {
                lastSnapshotAt: snapshotFetchedAt,
                snapshotRecordCount: body.recordCount ?? null,
                latestSnapshotHash: body.snapshotHash,
              }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(dataSources.id, dataSourceId));

      return { id: inserted.id, deduplicated: false } as const;
    });

    if (result.deduplicated) {
      return c.json({ ok: true, id: result.id, deduplicated: true });
    }
    return c.json({ ok: true, id: result.id, deduplicated: false }, 201);
  })

  // GET /:id/snapshots/latest — most recent snapshot with raw_content
  .get("/:id/snapshots/latest", async (c) => {
    const db = getDrizzleDb();
    const dataSourceId = c.req.param("id");

    const [row] = await db
      .select()
      .from(sourceSnapshots)
      .where(eq(sourceSnapshots.dataSourceId, dataSourceId))
      .orderBy(desc(sourceSnapshots.fetchedAt))
      .limit(1);

    if (!row) return notFoundError(c, "No snapshots found for this data source");

    return c.json({
      id: row.id,
      dataSourceId: row.dataSourceId,
      snapshotHash: row.snapshotHash,
      recordCount: row.recordCount,
      rawContent: row.rawContent,
      fetchedAt: row.fetchedAt.toISOString(),
      mappingValid: row.mappingValid,
      parserVersion: row.parserVersion,
      notes: row.notes,
      createdAt: row.createdAt.toISOString(),
    });
  });

export const dataSourcesRoute = dataSourcesApp;
export type DataSourcesRoute = typeof dataSourcesApp;
