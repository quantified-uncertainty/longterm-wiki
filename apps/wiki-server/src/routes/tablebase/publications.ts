import { Hono } from "hono";
import { z } from "zod";
import { eq, count, desc, sql } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { publications } from "../../schema.js";
import {
  zv,
  clampedLimit,
} from "../shared/utils.js";
import {
  resolveEntityId,
  type ResolvedEntityVars,
} from "../shared/resolve-entity-middleware.js";
import { InlineSourcingSchema } from "./sourcing-schema.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { createSyncHandler } from "./sync-factory.js";
import { registerComposer, composeThing } from "../shared/compose-thing.js";

// ---- QUA-470 Phase 4b-B.1: publication composer ----
interface PublicationComposerRow {
  title: string;
  entityId: string;
  authors?: string | null;
  venue?: string | null;
  publishedDate?: string | null;
}

registerComposer<PublicationComposerRow>("publication", (row, titleMap) => ({
  title: row.title,
  description:
    [row.authors, row.venue, row.publishedDate].filter(Boolean).join(", ") || null,
  parentTitle: titleMap.get(row.entityId) ?? row.entityId,
}));

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
  limit: clampedLimit(MAX_PAGE_SIZE, 200),
  offset: z.coerce.number().int().min(0).default(0),
  publicationType: z.enum(VALID_PUBLICATION_TYPES).optional(),
  flagshipOnly: z.coerce.boolean().optional(),
});

const ByEntityQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 100),
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
  sourcing: InlineSourcingSchema.optional(),
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

  .post(
    "/sync",
    createSyncHandler({
      name: "publications",
      table: publications,
      syncSchema: SyncItemSchema,
      entityRefs: ["entityId"],
      toThing: (item, titleMap) => {
        const composed = composeThing<PublicationComposerRow>("publication", item, titleMap);
        return {
          id: item.id,
          thingType: "publication" as const,
          title: composed.title,
          description: composed.description,
          parentTitle: composed.parentTitle,
          sourceTable: "publications",
          sourceId: item.id,
          parentThingId: item.entityId,
          sourceUrl: item.url ?? item.source ?? null,
        };
      },
      thingsTitleIds: (items) => [
        ...new Set(items.map((i) => i.entityId)),
      ],
      toVerdict: (item) => ({
        recordType: "publication",
        recordId: item.id,
        entityId: item.entityId,
        sourceUrl: item.url ?? item.source ?? null,
        sourcing: item.sourcing ?? null,
      }),
    }),
  )

  .post("/delete-batch", deleteBatchHandler(publications, "publications"));

export const publicationsRoute = publicationsApp;
export type PublicationsRoute = typeof publicationsApp;
