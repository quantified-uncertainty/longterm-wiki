/**
 * safety_frameworks (QUA-691 Phase 4).
 *
 * Per-lab framework registry (~12 rows total). One row per lab's safety
 * framework — Anthropic RSP, OpenAI Preparedness Framework, etc.
 */

import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, desc, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDrizzleDb } from "../../db.js";
import { safetyFrameworks, entities } from "../../schema.js";
import {
  zv,
  clampedLimit,
  noDuplicateIds,
  notFoundError,
} from "../shared/utils.js";
import { paginatedQuery } from "../shared/paginated-query.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { createSyncHandler } from "./sync-factory.js";

const MAX_PAGE_SIZE = 200;

const VALID_STATUS = ["active", "archived", "superseded", "draft"] as const;

// ---- Query schemas ----

const AllQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 100),
  offset: z.coerce.number().int().min(0).default(0),
  org_id: z.string().max(200).optional(),
  current_status: z.enum(VALID_STATUS).optional(),
});

// ---- Sync schemas ----

const SyncItemSchema = z.object({
  id: z.string().regex(
    /^[A-Za-z0-9_-]{10}$/,
    "id must be 10 alphanumeric characters (hyphens and underscores allowed)",
  ),
  orgId: z.string().min(1).max(200),
  orgDisplayName: z.string().max(500).nullable().optional(),
  name: z.string().min(1).max(500),
  shortName: z.string().max(100).nullable().optional(),
  latestVersionId: z.string().max(200).nullable().optional(),
  firstPublishedDate: z.string().max(20).nullable().optional(), // ISO date
  currentStatus: z.enum(VALID_STATUS).nullable().optional(),
  frameworkFamily: z.string().max(200).nullable().optional(),
  notes: z.string().max(10_000).nullable().optional(),
});

const SyncBatchSchema = z.object({
  items: z
    .array(SyncItemSchema)
    .min(1)
    .max(200)
    .refine(noDuplicateIds, { message: "Duplicate id values in items array" }),
});

// ---- Helpers ----

const orgEntity = alias(entities, "org_entity");

interface Row {
  framework: typeof safetyFrameworks.$inferSelect;
  orgTitle: string | null;
  orgSlug: string | null;
}

function formatRow(r: Row) {
  const f = r.framework;
  return {
    ...f,
    org: {
      id: f.orgId,
      slug: r.orgSlug,
      title: r.orgTitle,
      displayName: f.orgDisplayName ?? r.orgTitle ?? f.orgId,
    },
  };
}

// ---- Route ----

const safetyFrameworksApp = new Hono()

  .get("/stats", async (c) => {
    const db = getDrizzleDb();
    const [row] = await db
      .select({
        total: count(),
        orgs: sql<number>`count(distinct ${safetyFrameworks.orgId})`,
        active: sql<number>`count(*) filter (where ${safetyFrameworks.currentStatus} = 'active')`,
      })
      .from(safetyFrameworks);

    return c.json({
      total: row.total,
      orgs: Number(row.orgs),
      active: Number(row.active),
    });
  })

  .get("/all", zv("query", AllQuery), async (c) => {
    const { limit, offset, org_id, current_status } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions: SQL[] = [];
    if (org_id) conditions.push(eq(safetyFrameworks.orgId, org_id));
    if (current_status) conditions.push(eq(safetyFrameworks.currentStatus, current_status));

    const where =
      conditions.length === 0
        ? undefined
        : conditions.length === 1
          ? conditions[0]
          : and(...conditions);

    const { rows, total } = await paginatedQuery({
      query: db
        .select({
          framework: safetyFrameworks,
          orgTitle: orgEntity.title,
          orgSlug: orgEntity.id,
        })
        .from(safetyFrameworks)
        .leftJoin(orgEntity, eq(safetyFrameworks.orgId, orgEntity.stableId))
        .where(where)
        .orderBy(desc(safetyFrameworks.firstPublishedDate), safetyFrameworks.name)
        .limit(limit)
        .offset(offset),
      countQuery: db
        .select({ count: count() })
        .from(safetyFrameworks)
        .where(where),
      formatRow,
    });

    return c.json({ items: rows, total, limit, offset });
  })

  .get("/by-entity/:entityId", zv("query", AllQuery), async (c) => {
    const entityId = c.req.param("entityId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const where = eq(safetyFrameworks.orgId, entityId);
    const { rows, total } = await paginatedQuery({
      query: db
        .select({
          framework: safetyFrameworks,
          orgTitle: orgEntity.title,
          orgSlug: orgEntity.id,
        })
        .from(safetyFrameworks)
        .leftJoin(orgEntity, eq(safetyFrameworks.orgId, orgEntity.stableId))
        .where(where)
        .orderBy(desc(safetyFrameworks.firstPublishedDate))
        .limit(limit)
        .offset(offset),
      countQuery: db
        .select({ count: count() })
        .from(safetyFrameworks)
        .where(where),
      formatRow,
    });

    return c.json({ entityId, items: rows, total, limit, offset });
  })

  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const db = getDrizzleDb();

    const rows = await db
      .select({
        framework: safetyFrameworks,
        orgTitle: orgEntity.title,
        orgSlug: orgEntity.id,
      })
      .from(safetyFrameworks)
      .leftJoin(orgEntity, eq(safetyFrameworks.orgId, orgEntity.stableId))
      .where(eq(safetyFrameworks.id, id))
      .limit(1);

    if (rows.length === 0) {
      return notFoundError(c, `Safety framework ${id} not found`);
    }

    return c.json(formatRow(rows[0]));
  })

  .post(
    "/sync",
    createSyncHandler({
      name: "safety-frameworks",
      table: safetyFrameworks,
      batchSchema: SyncBatchSchema,
      entityRefs: ["orgId"],
      toRow: (item, now) => ({
        ...item,
        syncedAt: now,
        updatedAt: now,
      }),
      conflictSet: {
        orgId: sql`excluded.org_id`,
        orgDisplayName: sql`COALESCE(excluded.org_display_name, ${safetyFrameworks.orgDisplayName})`,
        name: sql`excluded.name`,
        shortName: sql`COALESCE(excluded.short_name, ${safetyFrameworks.shortName})`,
        latestVersionId: sql`COALESCE(excluded.latest_version_id, ${safetyFrameworks.latestVersionId})`,
        firstPublishedDate: sql`COALESCE(excluded.first_published_date, ${safetyFrameworks.firstPublishedDate})`,
        currentStatus: sql`COALESCE(excluded.current_status, ${safetyFrameworks.currentStatus})`,
        frameworkFamily: sql`COALESCE(excluded.framework_family, ${safetyFrameworks.frameworkFamily})`,
        notes: sql`COALESCE(excluded.notes, ${safetyFrameworks.notes})`,
        syncedAt: sql`now()`,
        updatedAt: sql`now()`,
      },
      auditRecordType: "safety_frameworks",
      toThing: (item) => ({
        id: item.id,
        thingType: "safety-framework" as const,
        parentThingId: item.orgId,
        sourceTable: "safety_frameworks",
        sourceId: item.id,
      }),
    }),
  )

  .post("/delete-batch", deleteBatchHandler(safetyFrameworks, "safety_frameworks"));

export const safetyFrameworksRoute = safetyFrameworksApp;
export type SafetyFrameworksRoute = typeof safetyFrameworksApp;
