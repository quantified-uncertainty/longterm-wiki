import { Hono } from "hono";
import { z } from "zod";
import { eq, count, desc, sql } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { publications } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
} from "../shared/utils.js";
import {
  resolveEntityId,
  type ResolvedEntityVars,
} from "../shared/resolve-entity-middleware.js";
import {
  upsertThingsInTx,
  resolveEntityTitles,
} from "../shared/thing-sync.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

const VALID_PUBLICATION_TYPES = [
  "paper",
  "report",
  "blog-post",
  "book",
  "thesis",
  "preprint",
  "policy-brief",
] as const;

// ---- Schemas ----

const AllQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(200),
  offset: z.coerce.number().int().min(0).default(0),
  publicationType: z.enum(VALID_PUBLICATION_TYPES).optional(),
  flagshipOnly: z.coerce.boolean().optional(),
});

const ByEntityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  publicationType: z.enum(VALID_PUBLICATION_TYPES).optional(),
  flagshipOnly: z.coerce.boolean().optional(),
});

const SyncItemSchema = z.object({
  id: z.string().length(10),
  entityId: z.string().min(1).max(200),
  entityDisplayName: z.string().max(500).nullable().optional(),
  resourceId: z.string().max(200).nullable().optional(),
  title: z.string().min(1).max(2000),
  authors: z.string().max(5000).nullable().optional(),
  url: z.string().max(2000).nullable().optional(),
  venue: z.string().max(500).nullable().optional(),
  publishedDate: z.string().max(10).nullable().optional(), // YYYY or YYYY-MM
  publicationType: z.enum(VALID_PUBLICATION_TYPES).default("paper"),
  citationCount: z.number().int().min(0).nullable().optional(),
  isFlagship: z.boolean().default(false),
  abstract: z.string().max(10000).nullable().optional(),
  source: z.string().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const SyncBatchSchema = z.object({
  items: z.array(SyncItemSchema).min(1).max(500),
});

// ---- Route ----

const publicationsApp = new Hono<{ Variables: ResolvedEntityVars }>()

  .get("/stats", async (c) => {
    const db = getDrizzleDb();
    const [statsRow] = await db
      .select({
        total: count(),
        flagshipCount: sql<number>`count(*) filter (where ${publications.isFlagship})`,
      })
      .from(publications);
    return c.json({
      total: statsRow.total,
      flagshipCount: Number(statsRow.flagshipCount),
    });
  })

  .get("/all", zv("query", AllQuery), async (c) => {
    const { limit, offset, publicationType, flagshipOnly } =
      c.req.valid("query");
    const db = getDrizzleDb();

    let query = db
      .select()
      .from(publications)
      .orderBy(desc(publications.publishedDate), publications.id)
      .limit(limit)
      .offset(offset);

    // Apply filters via post-query filtering for simplicity
    // (Drizzle's dynamic where-building is verbose for optional combos)
    const rows = await query;

    const filtered = rows.filter((r) => {
      if (publicationType && r.publicationType !== publicationType) return false;
      if (flagshipOnly && !r.isFlagship) return false;
      return true;
    });

    const [{ count: total }] = await db
      .select({ count: count() })
      .from(publications);

    return c.json({
      publications: filtered,
      total,
      limit,
      offset,
    });
  })

  .get(
    "/by-entity/:entityId",
    resolveEntityId(),
    zv("query", ByEntityQuery),
    async (c) => {
      const resolvedId = c.get("resolvedEntityId");
      const { limit, offset, publicationType, flagshipOnly } =
        c.req.valid("query");
      const db = getDrizzleDb();

      const rows = await db
        .select()
        .from(publications)
        .where(eq(publications.entityId, resolvedId))
        .orderBy(desc(publications.publishedDate), publications.id)
        .limit(limit)
        .offset(offset);

      const filtered = rows.filter((r) => {
        if (publicationType && r.publicationType !== publicationType)
          return false;
        if (flagshipOnly && !r.isFlagship) return false;
        return true;
      });

      const [{ count: total }] = await db
        .select({ count: count() })
        .from(publications)
        .where(eq(publications.entityId, resolvedId));

      return c.json({
        entityId: resolvedId,
        publications: filtered,
        total,
        limit,
        offset,
      });
    }
  )

  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;
    const db = getDrizzleDb();
    const now = new Date();
    let upserted = 0;

    await db.transaction(async (tx) => {
      const entityIds = [...new Set(items.map((i) => i.entityId))];
      const titleMap = await resolveEntityTitles(tx, entityIds);

      for (const item of items) {
        await tx
          .insert(publications)
          .values({
            id: item.id,
            entityId: item.entityId,
            entityDisplayName: item.entityDisplayName ?? null,
            resourceId: item.resourceId ?? null,
            title: item.title,
            authors: item.authors ?? null,
            url: item.url ?? null,
            venue: item.venue ?? null,
            publishedDate: item.publishedDate ?? null,
            publicationType: item.publicationType,
            citationCount: item.citationCount ?? null,
            isFlagship: item.isFlagship,
            abstract: item.abstract ?? null,
            source: item.source ?? null,
            notes: item.notes ?? null,
            syncedAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: publications.id,
            set: {
              entityId: item.entityId,
              entityDisplayName: item.entityDisplayName ?? null,
              resourceId: item.resourceId ?? null,
              title: item.title,
              authors: item.authors ?? null,
              url: item.url ?? null,
              venue: item.venue ?? null,
              publishedDate: item.publishedDate ?? null,
              publicationType: item.publicationType,
              citationCount: item.citationCount ?? null,
              isFlagship: item.isFlagship,
              abstract: item.abstract ?? null,
              source: item.source ?? null,
              notes: item.notes ?? null,
              syncedAt: now,
              updatedAt: now,
            },
          });
        upserted++;
      }

      const entityTitle = (id: string) => titleMap.get(id) ?? id;

      await upsertThingsInTx(
        tx,
        items.map((i) => ({
          id: i.id,
          thingType: "publication" as const,
          title: i.title,
          sourceTable: "publications",
          sourceId: i.id,
          parentThingId: i.entityId,
          parentTitle: entityTitle(i.entityId),
          sourceUrl: i.url ?? i.source ?? null,
          description:
            [i.authors, i.venue, i.publishedDate].filter(Boolean).join(", ") ||
            null,
        }))
      );
    });

    return c.json({ upserted });
  });

export const publicationsRoute = publicationsApp;
export type PublicationsRoute = typeof publicationsApp;
