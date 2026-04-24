import { Hono } from "hono";
import { createHash } from "crypto";
import { z } from "zod";
import { eq, count, desc, and, sql } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import {
  websiteSources,
  websiteSourcePages,
  pageSnapshots,
  entities,
} from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  notFoundError,
  paginationQuery,
  zv,
  clampedLimit,
  qBool,
} from "../shared/utils.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { validateEntityRefs } from "../shared/validate-entity-refs.js";
import { createSyncHandler } from "./sync-factory.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

const VALID_RELIABILITY = ["high", "medium", "low"] as const;

const VALID_PAGE_ROLES = [
  "about",
  "team",
  "research",
  "pricing",
  "careers",
  "docs",
  "landing",
  "blog-index",
  "other",
] as const;

// ---- Schemas ----

const AllQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 200),
  offset: z.coerce.number().int().min(0).default(0),
  enabled: qBool.optional(),
});

const ByEntityQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 100),
  offset: z.coerce.number().int().min(0).default(0),
});

const SyncSourceSchema = z.object({
  id: z.string().length(10),
  domain: z.string().min(1).max(500),
  entityId: z.string().min(1).max(200).nullable().optional(),
  entityDisplayName: z.string().max(500).nullable().optional(),
  reliability: z.enum(VALID_RELIABILITY).default("medium"),
  refreshIntervalDays: z.coerce.number().int().min(1).max(365).default(30),
  enabled: z.boolean().default(true),
  notes: z.string().max(5000).nullable().optional(),
});

const SyncPageSchema = z.object({
  id: z.string().length(10),
  sourceId: z.string().length(10),
  path: z.string().min(1).max(2000),
  pageRole: z.enum(VALID_PAGE_ROLES).nullable().optional(),
  extractTargets: z.array(z.string().max(200)).max(50).nullable().optional(),
  refreshIntervalDays: z.coerce.number().int().min(1).max(365).nullable().optional(),
  enabled: z.boolean().default(true),
});

const SyncPageBatchSchema = z.object({
  items: z.array(SyncPageSchema).min(1).max(500),
});

const VALID_EXTRACTION_STATUSES = [
  "pending",
  "extracted",
  "failed",
  "skipped",
] as const;

const CreateSnapshotSchema = z.object({
  id: z.string().length(10),
  websiteSourcePageId: z.string().length(10),
  url: z.string().min(1).max(4000),
  contentHash: z.string().length(64),
  fullText: z.string().min(1).max(10_000_000),
  titleAtTime: z.string().max(1000).nullable().optional(),
  httpStatus: z.number().int().min(0).max(999).default(200),
  contentLength: z.number().int().min(0).default(0),
  extractionStatus: z.enum(VALID_EXTRACTION_STATUSES).default("pending"),
  fetchedAt: z.string().datetime().optional(),
}).transform((data) => {
  // Strip NUL bytes from fullText, then recompute contentHash and contentLength
  // to ensure consistency (CodeRabbit #3788 review).
  const stripped = data.fullText.replace(/\0/g, "");
  const recomputedHash = createHash("sha256").update(stripped).digest("hex");
  return {
    ...data,
    fullText: stripped,
    contentHash: recomputedHash,
    contentLength: stripped.length,
  };
});

const SnapshotListQuery = paginationQuery({ defaultLimit: 20, maxLimit: 100 });

const PendingSnapshotsQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 50),
  offset: z.coerce.number().int().min(0).default(0),
});

const UpdateExtractionSchema = z.object({
  extractionStatus: z.enum(VALID_EXTRACTION_STATUSES),
  extractedFacts: z.unknown().nullable().optional(),
});

// ---- Typed row interfaces for raw SQL ----

interface SourceWithPageCount {
  id: string;
  domain: string;
  entity_id: string | null;
  entity_display_name: string | null;
  reliability: string;
  refresh_interval_days: number;
  enabled: boolean;
  notes: string | null;
  last_run_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
  page_count: number;
}

// ---- Route ----

const websiteSourcesApp = new Hono()

  .get("/stats", async (c) => {
    const db = getDrizzleDb();
    const [sourcesCount] = await db
      .select({ total: count() })
      .from(websiteSources);
    const [pagesCount] = await db
      .select({ total: count() })
      .from(websiteSourcePages);
    const [enabledSources] = await db
      .select({ total: count() })
      .from(websiteSources)
      .where(eq(websiteSources.enabled, true));
    const [enabledPages] = await db
      .select({ total: count() })
      .from(websiteSourcePages)
      .where(eq(websiteSourcePages.enabled, true));

    return c.json({
      sources: { total: sourcesCount.total, enabled: enabledSources.total },
      pages: { total: pagesCount.total, enabled: enabledPages.total },
    });
  })

  .get("/all", zv("query", AllQuery), async (c) => {
    const { limit, offset, enabled } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = enabled !== undefined
      ? eq(websiteSources.enabled, enabled)
      : undefined;

    const rows = await db
      .select()
      .from(websiteSources)
      .where(conditions)
      .orderBy(desc(websiteSources.updatedAt), websiteSources.id)
      .limit(limit)
      .offset(offset);

    const [{ count: total }] = await db
      .select({ count: count() })
      .from(websiteSources)
      .where(conditions);

    // Fetch page counts per source
    const pageCountRows = rows.length > 0
      ? await db
          .select({
            sourceId: websiteSourcePages.sourceId,
            pageCount: count(),
          })
          .from(websiteSourcePages)
          .where(
            sql`${websiteSourcePages.sourceId} IN (${sql.join(
              rows.map((r) => sql`${r.id}`),
              sql`, `
            )})`
          )
          .groupBy(websiteSourcePages.sourceId)
      : [];

    const pageCountMap = new Map(
      pageCountRows.map((r) => [r.sourceId, r.pageCount])
    );

    const sourcesWithPages = rows.map((r) => ({
      ...r,
      pageCount: pageCountMap.get(r.id) ?? 0,
    }));

    return c.json({ sources: sourcesWithPages, total, limit, offset });
  })

  .get("/by-entity/:entityId", zv("query", ByEntityQuery), async (c) => {
    const entityId = c.req.param("entityId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    // Resolve entity — try stableId first, fall back to slug
    let resolvedId = entityId;
    const [byStable] = await db
      .select({ stableId: entities.stableId })
      .from(entities)
      .where(eq(entities.stableId, entityId))
      .limit(1);
    if (!byStable) {
      const [bySlug] = await db
        .select({ stableId: entities.stableId })
        .from(entities)
        .where(eq(entities.id, entityId))
        .limit(1);
      if (bySlug) resolvedId = bySlug.stableId;
    }

    const rows = await db
      .select()
      .from(websiteSources)
      .where(eq(websiteSources.entityId, resolvedId))
      .orderBy(websiteSources.domain)
      .limit(limit)
      .offset(offset);

    return c.json({ entityId: resolvedId, sources: rows, limit, offset });
  })

  .get("/:sourceId/pages", async (c) => {
    const sourceId = c.req.param("sourceId");
    const db = getDrizzleDb();

    const pages = await db
      .select()
      .from(websiteSourcePages)
      .where(eq(websiteSourcePages.sourceId, sourceId))
      .orderBy(websiteSourcePages.path)
      .limit(5000);

    return c.json({ sourceId, pages });
  })

  .post(
    "/sync",
    createSyncHandler({
      name: "website-sources",
      table: websiteSources,
      syncSchema: SyncSourceSchema,
      entityRefs: ["entityId"],
      // Explicit toRow: only set sync-controlled fields. The table has
      // operational columns (lastRunAt, lastError, consecutiveFailures)
      // that must be preserved on conflict — omitting them from the row
      // keeps them out of the auto-derived SET clause.
      toRow: (item, now) => ({
        id: item.id,
        domain: item.domain,
        entityId: item.entityId ?? null,
        entityDisplayName: item.entityDisplayName ?? null,
        reliability: item.reliability,
        refreshIntervalDays: item.refreshIntervalDays,
        enabled: item.enabled,
        notes: item.notes ?? null,
        updatedAt: now,
      }),
    }),
  )

  .post("/sync-pages", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncPageBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;
    const db = getDrizzleDb();
    const now = new Date();
    let upserted = 0;

    await db.transaction(async (tx) => {
      for (const item of items) {
        await tx
          .insert(websiteSourcePages)
          .values({
            id: item.id,
            sourceId: item.sourceId,
            path: item.path,
            pageRole: item.pageRole ?? null,
            extractTargets: item.extractTargets ?? null,
            refreshIntervalDays: item.refreshIntervalDays ?? null,
            enabled: item.enabled,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: websiteSourcePages.id,
            set: {
              sourceId: item.sourceId,
              path: item.path,
              pageRole: item.pageRole ?? null,
              extractTargets: item.extractTargets ?? null,
              refreshIntervalDays: item.refreshIntervalDays ?? null,
              enabled: item.enabled,
              updatedAt: now,
            },
          });
        upserted++;
      }
    });

    return c.json({ upserted });
  })

  // ── Page Snapshot endpoints ───────────────────────────────────────

  .get(
    "/:sourceId/snapshots",
    zv("query", SnapshotListQuery),
    async (c) => {
      const sourceId = c.req.param("sourceId");
      const { limit, offset } = c.req.valid("query");
      const db = getDrizzleDb();

      // Verify source exists
      const [source] = await db
        .select({ id: websiteSources.id })
        .from(websiteSources)
        .where(eq(websiteSources.id, sourceId))
        .limit(1);
      if (!source) return notFoundError(c, "Website source not found");

      // Join through pages to get snapshots for this source
      const sourcePageFilter = eq(websiteSourcePages.sourceId, sourceId);

      const [totalRow] = await db
        .select({ count: count() })
        .from(pageSnapshots)
        .innerJoin(
          websiteSourcePages,
          eq(pageSnapshots.websiteSourcePageId, websiteSourcePages.id)
        )
        .where(sourcePageFilter);
      const total = totalRow?.count ?? 0;

      if (total === 0) {
        return c.json({ snapshots: [], total: 0, limit, offset });
      }

      const rows = await db
        .select({ snapshot: pageSnapshots })
        .from(pageSnapshots)
        .innerJoin(
          websiteSourcePages,
          eq(pageSnapshots.websiteSourcePageId, websiteSourcePages.id)
        )
        .where(sourcePageFilter)
        .orderBy(desc(pageSnapshots.fetchedAt))
        .limit(limit)
        .offset(offset);

      return c.json({
        snapshots: rows.map(({ snapshot: r }) => ({
          id: r.id,
          websiteSourcePageId: r.websiteSourcePageId,
          url: r.url,
          fetchedAt: r.fetchedAt.toISOString(),
          contentHash: r.contentHash,
          titleAtTime: r.titleAtTime,
          httpStatus: r.httpStatus,
          contentLength: r.contentLength,
          extractionStatus: r.extractionStatus,
          extractedAt: r.extractedAt?.toISOString() ?? null,
          createdAt: r.createdAt.toISOString(),
        })),
        total,
        limit,
        offset,
      });
    }
  )

  .get("/:sourceId/snapshots/:snapshotId", async (c) => {
    const sourceId = c.req.param("sourceId");
    const snapshotId = c.req.param("snapshotId");
    const db = getDrizzleDb();

    // Verify snapshot belongs to this source by joining through pages
    const [row] = await db
      .select({
        snapshot: pageSnapshots,
      })
      .from(pageSnapshots)
      .innerJoin(
        websiteSourcePages,
        eq(pageSnapshots.websiteSourcePageId, websiteSourcePages.id)
      )
      .where(
        and(
          eq(pageSnapshots.id, snapshotId),
          eq(websiteSourcePages.sourceId, sourceId)
        )
      )
      .limit(1);

    if (!row) return notFoundError(c, "Snapshot not found");

    const s = row.snapshot;
    return c.json({
      id: s.id,
      websiteSourcePageId: s.websiteSourcePageId,
      url: s.url,
      fetchedAt: s.fetchedAt.toISOString(),
      contentHash: s.contentHash,
      fullText: s.fullText,
      titleAtTime: s.titleAtTime,
      httpStatus: s.httpStatus,
      contentLength: s.contentLength,
      extractionStatus: s.extractionStatus,
      extractedAt: s.extractedAt?.toISOString() ?? null,
      extractedFacts: s.extractedFacts,
      createdAt: s.createdAt.toISOString(),
    });
  })

  .post(
    "/:sourceId/snapshots",
    zv("json", CreateSnapshotSchema),
    async (c) => {
      const sourceId = c.req.param("sourceId");
      const body = c.req.valid("json");
      const db = getDrizzleDb();

      // Verify the page belongs to this source
      const [page] = await db
        .select({ id: websiteSourcePages.id })
        .from(websiteSourcePages)
        .where(
          and(
            eq(websiteSourcePages.id, body.websiteSourcePageId),
            eq(websiteSourcePages.sourceId, sourceId)
          )
        )
        .limit(1);

      if (!page) {
        return validationError(
          c,
          `Page ${body.websiteSourcePageId} not found under source ${sourceId}`
        );
      }

      const fetchedAt = body.fetchedAt ? new Date(body.fetchedAt) : new Date();

      // Atomic insert + parent update in a transaction.
      // Raise statement_timeout for large fullText (up to 10MB).
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '120000'`);

        const [inserted] = await tx
          .insert(pageSnapshots)
          .values({
            id: body.id,
            websiteSourcePageId: body.websiteSourcePageId,
            url: body.url,
            contentHash: body.contentHash,
            fullText: body.fullText,
            titleAtTime: body.titleAtTime ?? null,
            httpStatus: body.httpStatus,
            contentLength: body.contentLength,
            extractionStatus: body.extractionStatus,
            fetchedAt,
          })
          .onConflictDoNothing({
            target: [
              pageSnapshots.websiteSourcePageId,
              pageSnapshots.contentHash,
            ],
          })
          .returning({ id: pageSnapshots.id });

        if (!inserted) {
          const [existing] = await tx
            .select({ id: pageSnapshots.id })
            .from(pageSnapshots)
            .where(
              and(
                eq(
                  pageSnapshots.websiteSourcePageId,
                  body.websiteSourcePageId
                ),
                eq(pageSnapshots.contentHash, body.contentHash)
              )
            );
          return { id: existing?.id ?? body.id, deduplicated: true } as const;
        }

        // Only advance parent tracking if this snapshot is newer
        const [currentPage] = await tx
          .select({ lastFetchedAt: websiteSourcePages.lastFetchedAt })
          .from(websiteSourcePages)
          .where(eq(websiteSourcePages.id, body.websiteSourcePageId));

        const shouldAdvance =
          !currentPage?.lastFetchedAt || fetchedAt >= currentPage.lastFetchedAt;

        await tx
          .update(websiteSourcePages)
          .set({
            ...(shouldAdvance
              ? {
                  lastFetchedAt: fetchedAt,
                  lastContentHash: body.contentHash,
                  lastSnapshotId: inserted.id,
                }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(websiteSourcePages.id, body.websiteSourcePageId));

        return { id: inserted.id, deduplicated: false } as const;
      });

      if (result.deduplicated) {
        return c.json({ ok: true, id: result.id, deduplicated: true });
      }
      return c.json(
        { ok: true, id: result.id, deduplicated: false },
        201
      );
    }
  )

  // ── List snapshots by extraction status (cross-source) ────────────
  //
  // Used by `crux tb website-sources extract` to find pending snapshots
  // without iterating all sources. The snapshot route is unusual in that
  // we expose this cross-source lookup — sources are scoped by ID for
  // writes, but extraction-status reads are inherently global.

  .get(
    "/snapshots/pending",
    zv("query", PendingSnapshotsQuery),
    async (c) => {
      const { limit, offset } = c.req.valid("query");
      const db = getDrizzleDb();

      const [totalRow] = await db
        .select({ count: count() })
        .from(pageSnapshots)
        .where(eq(pageSnapshots.extractionStatus, "pending"));
      const total = totalRow?.count ?? 0;

      if (total === 0) {
        return c.json({ snapshots: [], total: 0, limit, offset });
      }

      const rows = await db
        .select({
          snapshot: pageSnapshots,
          page: websiteSourcePages,
          source: websiteSources,
        })
        .from(pageSnapshots)
        .innerJoin(
          websiteSourcePages,
          eq(pageSnapshots.websiteSourcePageId, websiteSourcePages.id)
        )
        .innerJoin(
          websiteSources,
          eq(websiteSourcePages.sourceId, websiteSources.id)
        )
        .where(eq(pageSnapshots.extractionStatus, "pending"))
        .orderBy(pageSnapshots.fetchedAt)
        .limit(limit)
        .offset(offset);

      return c.json({
        snapshots: rows.map((r) => ({
          id: r.snapshot.id,
          websiteSourcePageId: r.snapshot.websiteSourcePageId,
          sourceId: r.source.id,
          domain: r.source.domain,
          entityId: r.source.entityId,
          entityDisplayName: r.source.entityDisplayName,
          pagePath: r.page.path,
          pageRole: r.page.pageRole,
          url: r.snapshot.url,
          fetchedAt: r.snapshot.fetchedAt.toISOString(),
          contentHash: r.snapshot.contentHash,
          contentLength: r.snapshot.contentLength,
          extractionStatus: r.snapshot.extractionStatus,
        })),
        total,
        limit,
        offset,
      });
    }
  )

  // ── Update extraction status + facts on a snapshot ─────────────────
  //
  // Used by the extract pipeline after proposing extracted rows via
  // /api/enrichment/propose. The `extractedFacts` JSONB payload is the
  // full extraction result (people, costs, rejections) — audit trail
  // for the per-page extraction yield.

  .post(
    "/:sourceId/snapshots/:snapshotId/extraction",
    zv("json", UpdateExtractionSchema),
    async (c) => {
      const sourceId = c.req.param("sourceId");
      const snapshotId = c.req.param("snapshotId");
      const body = c.req.valid("json");
      const db = getDrizzleDb();

      // Verify snapshot belongs to this source before writing.
      const [existing] = await db
        .select({ id: pageSnapshots.id })
        .from(pageSnapshots)
        .innerJoin(
          websiteSourcePages,
          eq(pageSnapshots.websiteSourcePageId, websiteSourcePages.id)
        )
        .where(
          and(
            eq(pageSnapshots.id, snapshotId),
            eq(websiteSourcePages.sourceId, sourceId)
          )
        )
        .limit(1);

      if (!existing) return notFoundError(c, "Snapshot not found");

      const now = new Date();
      await db
        .update(pageSnapshots)
        .set({
          extractionStatus: body.extractionStatus,
          extractedFacts:
            body.extractedFacts !== undefined ? body.extractedFacts : undefined,
          extractedAt:
            body.extractionStatus === "extracted" ||
            body.extractionStatus === "failed"
              ? now
              : null,
        })
        .where(eq(pageSnapshots.id, snapshotId));

      return c.json({ ok: true, id: snapshotId });
    }
  )

  .post("/delete-batch", deleteBatchHandler(websiteSources, null));

export const websiteSourcesRoute = websiteSourcesApp;
export type WebsiteSourcesRoute = typeof websiteSourcesApp;
