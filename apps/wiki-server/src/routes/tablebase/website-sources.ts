import { Hono } from "hono";
import { z } from "zod";
import { eq, count, desc, and, sql } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { websiteSources, websiteSourcePages, entities } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
  clampedLimit,
} from "../shared/utils.js";

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
  enabled: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
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

const SyncSourceBatchSchema = z.object({
  items: z.array(SyncSourceSchema).min(1).max(200),
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

  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncSourceBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;
    const db = getDrizzleDb();
    const now = new Date();
    let upserted = 0;

    await db.transaction(async (tx) => {
      for (const item of items) {
        await tx
          .insert(websiteSources)
          .values({
            id: item.id,
            domain: item.domain,
            entityId: item.entityId ?? null,
            entityDisplayName: item.entityDisplayName ?? null,
            reliability: item.reliability,
            refreshIntervalDays: item.refreshIntervalDays,
            enabled: item.enabled,
            notes: item.notes ?? null,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: websiteSources.id,
            set: {
              domain: item.domain,
              entityId: item.entityId ?? null,
              entityDisplayName: item.entityDisplayName ?? null,
              reliability: item.reliability,
              refreshIntervalDays: item.refreshIntervalDays,
              enabled: item.enabled,
              notes: item.notes ?? null,
              updatedAt: now,
            },
          });
        upserted++;
      }
    });

    return c.json({ upserted });
  })

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
  });

export const websiteSourcesRoute = websiteSourcesApp;
export type WebsiteSourcesRoute = typeof websiteSourcesApp;
