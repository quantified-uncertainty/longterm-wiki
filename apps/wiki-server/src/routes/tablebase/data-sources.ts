/**
 * Data Sources API — CRUD for tabular import pipelines.
 *
 * Uses resources + resource_tabular_sources as the sole data store.
 * Snapshot metadata (lastSnapshotAt, snapshotRecordCount, latestSnapshotHash)
 * is computed on-read from source_snapshots rather than denormalized.
 *
 * Hono RPC method-chained route for type inference.
 */

import { Hono } from "hono";
import { z } from "zod";
import { eq, desc, and, count, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { getDrizzleDb } from "../../db.js";
import { sourceSnapshots, resources, resourceTabularSources } from "../../schema.js";
import { paginationQuery, zv, notFoundError } from "../shared/utils.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { validateEntityRefs } from "../shared/validate-entity-refs.js";
import { generateId } from "@longterm-wiki/factbase";

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
  // Issue #4017 B5: typed schema replaces z.record(z.unknown()). The shape
  // is {strategy, matchFields, fuzzyFields, exactFields} from grant-import manifests.
  verificationConfig: z.object({
    strategy: z.string().max(100),
    matchFields: z.array(z.string().max(100)).optional(),
    fuzzyFields: z.array(z.string().max(100)).optional(),
    exactFields: z.array(z.string().max(100)).optional(),
  }).passthrough().nullable().optional(),
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

/** Row shape returned by the snapshot-metadata subquery in list/detail endpoints. */
interface SnapshotMeta {
  lastSnapshotAt: Date | null;
  snapshotRecordCount: number | null;
  latestSnapshotHash: string | null;
}

/**
 * Compute snapshot metadata for a single sourceSlug by querying source_snapshots.
 * Returns the most recent snapshot's fetchedAt, recordCount, and snapshotHash.
 * Uses fetchedAt DESC, id DESC for a stable deterministic ordering.
 */
async function getSnapshotMeta(db: ReturnType<typeof getDrizzleDb>, sourceSlug: string): Promise<SnapshotMeta> {
  const [row] = await db
    .select({
      fetchedAt: sourceSnapshots.fetchedAt,
      recordCount: sourceSnapshots.recordCount,
      snapshotHash: sourceSnapshots.snapshotHash,
    })
    .from(sourceSnapshots)
    .where(eq(sourceSnapshots.sourceSlug, sourceSlug))
    .orderBy(desc(sourceSnapshots.fetchedAt), desc(sourceSnapshots.id))
    .limit(1);

  return {
    lastSnapshotAt: row?.fetchedAt ?? null,
    snapshotRecordCount: row?.recordCount ?? null,
    latestSnapshotHash: row?.snapshotHash ?? null,
  };
}

/** Format a joined resource+rts row into the API response shape. */
function formatFromNewTables(
  res: typeof resources.$inferSelect,
  rts: typeof resourceTabularSources.$inferSelect,
  snap: SnapshotMeta,
) {
  return {
    id: rts.sourceSlug,
    name: res.title ?? rts.sourceSlug,
    dataFormat: rts.dataFormat,
    accessMethod: rts.accessMethod,
    recordType: rts.recordType,
    fetchUrl: res.url.startsWith("urn:") ? null : res.url,
    resourceId: rts.resourceId,
    publisherEntityId: res.publisherEntityId,
    updateFrequency: rts.updateFrequency,
    columnMapping: rts.columnMapping,
    sourceSchema: rts.sourceSchema,
    verificationConfig: rts.verificationConfig,
    lastSnapshotAt: snap.lastSnapshotAt?.toISOString() ?? null,
    snapshotRecordCount: snap.snapshotRecordCount,
    latestSnapshotHash: snap.latestSnapshotHash,
    sourceStatus: rts.sourceStatus,
    createdAt: rts.createdAt.toISOString(),
    updatedAt: rts.updatedAt.toISOString(),
  };
}

// ---- Route ----

const dataSourcesApp = new Hono()

  // GET / — list all data sources from resources + resource_tabular_sources
  .get("/", async (c) => {
    const db = getDrizzleDb();

    // Join new tables for the base data
    const rows = await db
      .select({
        res: resources,
        rts: resourceTabularSources,
      })
      .from(resourceTabularSources)
      .innerJoin(resources, eq(resources.id, resourceTabularSources.resourceId))
      .orderBy(resources.title);

    // Compute snapshot metadata for each source.
    // With ~14 sources this is fine as individual queries; if the count grows
    // significantly, switch to a single aggregation query.
    const formatted = await Promise.all(
      rows.map(async (r) => {
        const snap = await getSnapshotMeta(db, r.rts.sourceSlug);
        return formatFromNewTables(r.res, r.rts, snap);
      })
    );

    return c.json({ dataSources: formatted });
  })

  // GET /:id — single data source with latest snapshot metadata
  .get("/:id", async (c) => {
    const db = getDrizzleDb();
    const id = c.req.param("id");

    // Look up by sourceSlug (same as old data_sources.id)
    const [row] = await db
      .select({
        res: resources,
        rts: resourceTabularSources,
      })
      .from(resourceTabularSources)
      .innerJoin(resources, eq(resources.id, resourceTabularSources.resourceId))
      .where(eq(resourceTabularSources.sourceSlug, id));

    if (!row) return notFoundError(c, "Data source not found");

    // Read the latest snapshot once and derive top-level metadata from it.
    // Using fetchedAt DESC, id DESC for a stable deterministic ordering.
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
      .where(eq(sourceSnapshots.sourceSlug, id))
      .orderBy(desc(sourceSnapshots.fetchedAt), desc(sourceSnapshots.id))
      .limit(1);

    const snap: SnapshotMeta = {
      lastSnapshotAt: latestSnapshot?.fetchedAt ?? null,
      snapshotRecordCount: latestSnapshot?.recordCount ?? null,
      latestSnapshotHash: latestSnapshot?.snapshotHash ?? null,
    };

    return c.json({
      ...formatFromNewTables(row.res, row.rts, snap),
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

  // POST /sync — upsert a data source (new tables primary, old table best-effort)
  .post("/sync", zv("json", SyncDataSourceSchema), async (c) => {
    const db = getDrizzleDb();
    const body = c.req.valid("json");

    // Validate entity FK references (publisherEntityId is a soft FK to entities)
    const entityIds = [body.publisherEntityId].filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
    if (entityIds.length > 0) {
      const refError = await validateEntityRefs(c, db, [
        { fieldName: "publisherEntityId", ids: entityIds },
      ]);
      if (refError) return refError;
    }

    // 1. Write to new tables (PRIMARY)
    const url = body.fetchUrl ?? `urn:lw:tabular-source:${body.id}`;
    const resId = hashId(url);
    let actualResId = resId;

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
          // QUA-536: NOT NULL on resources.stable_id means this INSERT must
          // provide one. ON CONFLICT (url) keeps the existing stable_id.
          stableId: generateId(),
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
      .where(eq(sourceSnapshots.sourceSlug, id));
    const total = totalRow?.count ?? 0;

    const rows = await db
      .select({
        id: sourceSnapshots.id,
        dataSourceId: sourceSnapshots.sourceSlug,
        snapshotHash: sourceSnapshots.snapshotHash,
        recordCount: sourceSnapshots.recordCount,
        fetchedAt: sourceSnapshots.fetchedAt,
        mappingValid: sourceSnapshots.mappingValid,
        parserVersion: sourceSnapshots.parserVersion,
        notes: sourceSnapshots.notes,
        createdAt: sourceSnapshots.createdAt,
      })
      .from(sourceSnapshots)
      .where(eq(sourceSnapshots.sourceSlug, id))
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

    // Verify data source exists in new tables
    const [rts] = await db
      .select({ resourceId: resourceTabularSources.resourceId })
      .from(resourceTabularSources)
      .where(eq(resourceTabularSources.sourceSlug, dataSourceId));
    if (!rts) return notFoundError(c, "Data source not found");

    // Atomic INSERT ... ON CONFLICT DO NOTHING to avoid race conditions.
    // Large snapshots (16-40MB raw_content) can exceed the default 30s
    // statement_timeout, so we raise it for this transaction.
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '120000'`);

      const [inserted] = await tx
        .insert(sourceSnapshots)
        .values({
          sourceSlug: dataSourceId,
          resourceId: rts.resourceId,
          snapshotHash: body.snapshotHash,
          recordCount: body.recordCount ?? null,
          rawContent: body.rawContent,
          fetchedAt: body.fetchedAt ? new Date(body.fetchedAt) : new Date(),
          mappingValid: body.mappingValid ?? true,
          parserVersion: body.parserVersion ?? null,
          notes: body.notes ?? null,
        })
        .onConflictDoNothing({ target: [sourceSnapshots.sourceSlug, sourceSnapshots.snapshotHash] })
        .returning({ id: sourceSnapshots.id });

      if (!inserted) {
        // Content-hash dedup: this exact content already exists
        const [existing] = await tx
          .select({ id: sourceSnapshots.id })
          .from(sourceSnapshots)
          .where(and(
            eq(sourceSnapshots.sourceSlug, dataSourceId),
            eq(sourceSnapshots.snapshotHash, body.snapshotHash),
          ));
        return { id: existing?.id ?? 0, deduplicated: true } as const;
      }

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
      .where(eq(sourceSnapshots.sourceSlug, dataSourceId))
      .orderBy(desc(sourceSnapshots.fetchedAt))
      .limit(1);

    if (!row) return notFoundError(c, "No snapshots found for this data source");

    return c.json({
      id: row.id,
      dataSourceId: row.sourceSlug,
      snapshotHash: row.snapshotHash,
      recordCount: row.recordCount,
      rawContent: row.rawContent,
      fetchedAt: row.fetchedAt.toISOString(),
      mappingValid: row.mappingValid,
      parserVersion: row.parserVersion,
      notes: row.notes,
      createdAt: row.createdAt.toISOString(),
    });
  })

  .post("/delete-batch", deleteBatchHandler(resourceTabularSources, null, {
    label: "data-sources",
    pkColumn: resourceTabularSources.resourceId,
  }));

export const dataSourcesRoute = dataSourcesApp;
export type DataSourcesRoute = typeof dataSourcesApp;
