import { Hono } from "hono";
import { z } from "zod";
import { and, eq, count, desc, sql, type SQL } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { publications } from "../../schema.js";
import {
  zv,
  clampedLimit,
  qBool,
} from "../shared/utils.js";
import {
  resolveEntityId,
  type ResolvedEntityVars,
} from "../shared/resolve-entity-middleware.js";
import { InlineSourcingSchema } from "./sourcing-schema.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { createSyncHandler } from "./sync-factory.js";

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
  flagshipOnly: qBool.optional(),
});

const ByEntityQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 100),
  offset: z.coerce.number().int().min(0).default(0),
  publicationType: z.enum(VALID_PUBLICATION_TYPES).optional(),
  flagshipOnly: qBool.optional(),
});

const SyncItemSchema = z.object({
  id: z.string().length(10),
  entityId: z.string().min(1).max(200),
  entityDisplayName: z.string().max(500).nullable().optional(),
  // QUA-564 Phase B.1: publications.resource_id now FKs to resources.stable_id.
  // Callers must pass sid_-prefixed stable_ids, not legacy hex16 resources.id
  // values. No translation layer here — no current caller populates this field
  // (data/publications.yaml has zero resourceId entries). A future caller that
  // provides hex16 will hit a clear FK violation at insert time.
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

    const conditions: SQL[] = [];
    if (publicationType) {
      conditions.push(eq(publications.publicationType, publicationType));
    }
    if (flagshipOnly) {
      conditions.push(eq(publications.isFlagship, true));
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(publications)
      .where(whereClause)
      .orderBy(desc(publications.publishedDate), publications.id)
      .limit(limit)
      .offset(offset);

    const [{ count: total }] = await db
      .select({ count: count() })
      .from(publications)
      .where(whereClause);

    return c.json({
      publications: rows,
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

      const conditions: SQL[] = [eq(publications.entityId, resolvedId)];
      if (publicationType) {
        conditions.push(eq(publications.publicationType, publicationType));
      }
      if (flagshipOnly) {
        conditions.push(eq(publications.isFlagship, true));
      }
      const whereClause = and(...conditions);

      const rows = await db
        .select()
        .from(publications)
        .where(whereClause)
        .orderBy(desc(publications.publishedDate), publications.id)
        .limit(limit)
        .offset(offset);

      const [{ count: total }] = await db
        .select({ count: count() })
        .from(publications)
        .where(whereClause);

      return c.json({
        entityId: resolvedId,
        publications: rows,
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
      // QUA-507: pointer-only things write.
      toThing: (item) => ({
        id: item.id,
        thingType: "publication" as const,
        sourceTable: "publications",
        sourceId: item.id,
        parentThingId: item.entityId,
        sourceUrl: item.url ?? item.source ?? null,
      }),
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
