/**
 * framework_diff_items (QUA-691 Phase 4).
 *
 * Atomic change rows composing a framework_diff. Each row is one
 * structural change (threshold added, mitigation softened, etc.), with
 * before/after snapshots and an LLM classifier tag.
 */

import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { frameworkDiffItems } from "../../schema.js";
import {
  zv,
  clampedLimit,
  noDuplicateIds,
  notFoundError,
} from "../shared/utils.js";
import { paginatedQuery } from "../shared/paginated-query.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { createSyncHandler } from "./sync-factory.js";

const MAX_PAGE_SIZE = 1000;

const VALID_CHANGE_TYPE = [
  "threshold_added",
  "threshold_removed",
  "mitigation_softened",
  "mitigation_strengthened",
  "commitment_weakened",
  "commitment_strengthened",
  "scope_narrowed",
  "scope_broadened",
  "eval_changed",
  "clarification",
  "other",
] as const;

const VALID_CLASSIFIER_TAG = [
  "weaker",
  "stronger",
  "rewrite_equivalent",
  "scope_narrowed",
  "scope_broadened",
  "clarification",
] as const;

import { VALID_RISK_DOMAINS } from "../shared/framework-constants.js";

const AllQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 500),
  offset: z.coerce.number().int().min(0).default(0),
  diff_id: z.string().max(200).optional(),
  change_type: z.enum(VALID_CHANGE_TYPE).optional(),
});

const SyncItemSchema = z.object({
  id: z.string().regex(
    /^[A-Za-z0-9_-]{10}$/,
    "id must be 10 alphanumeric characters (hyphens and underscores allowed)",
  ),
  diffId: z.string().min(1).max(200),
  changeType: z.enum(VALID_CHANGE_TYPE),
  riskDomainCanonical: z.enum(VALID_RISK_DOMAINS).nullable().optional(),
  beforeSnapshot: z.record(z.unknown()).nullable().optional(),
  afterSnapshot: z.record(z.unknown()).nullable().optional(),
  severity: z.number().int().min(1).max(3).nullable().optional(),
  classifierTag: z.enum(VALID_CLASSIFIER_TAG).nullable().optional(),
  rationale: z.string().max(5000).nullable().optional(),
});

const SyncBatchSchema = z.object({
  items: z
    .array(SyncItemSchema)
    .min(1)
    .max(1000)
    .refine(noDuplicateIds, { message: "Duplicate id values in items array" }),
});

const diffItemsApp = new Hono()

  .get("/stats", async (c) => {
    const db = getDrizzleDb();
    const [row] = await db
      .select({
        total: count(),
        diffs: sql<number>`count(distinct ${frameworkDiffItems.diffId})`,
        weaker: sql<number>`count(*) filter (where ${frameworkDiffItems.classifierTag} = 'weaker')`,
        stronger: sql<number>`count(*) filter (where ${frameworkDiffItems.classifierTag} = 'stronger')`,
      })
      .from(frameworkDiffItems);
    return c.json({
      total: row.total,
      diffs: Number(row.diffs),
      weaker: Number(row.weaker),
      stronger: Number(row.stronger),
    });
  })

  .get("/all", zv("query", AllQuery), async (c) => {
    const { limit, offset, diff_id, change_type } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions: SQL[] = [];
    if (diff_id) conditions.push(eq(frameworkDiffItems.diffId, diff_id));
    if (change_type) conditions.push(eq(frameworkDiffItems.changeType, change_type));

    const where =
      conditions.length === 0
        ? undefined
        : conditions.length === 1
          ? conditions[0]
          : and(...conditions);

    const { rows, total } = await paginatedQuery({
      query: db
        .select()
        .from(frameworkDiffItems)
        .where(where)
        .orderBy(frameworkDiffItems.diffId, frameworkDiffItems.changeType)
        .limit(limit)
        .offset(offset),
      countQuery: db
        .select({ count: count() })
        .from(frameworkDiffItems)
        .where(where),
      formatRow: (r: typeof frameworkDiffItems.$inferSelect) => r,
    });

    return c.json({ items: rows, total, limit, offset });
  })

  .get("/by-diff/:diffId", zv("query", AllQuery), async (c) => {
    const diffId = c.req.param("diffId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();
    const where = eq(frameworkDiffItems.diffId, diffId);
    const { rows, total } = await paginatedQuery({
      query: db
        .select()
        .from(frameworkDiffItems)
        .where(where)
        .orderBy(frameworkDiffItems.changeType)
        .limit(limit)
        .offset(offset),
      countQuery: db
        .select({ count: count() })
        .from(frameworkDiffItems)
        .where(where),
      formatRow: (r: typeof frameworkDiffItems.$inferSelect) => r,
    });
    return c.json({ diffId, items: rows, total, limit, offset });
  })

  .get("/by-entity/:entityId", zv("query", AllQuery), async (c) => {
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
      .from(frameworkDiffItems)
      .where(eq(frameworkDiffItems.id, id))
      .limit(1);
    if (rows.length === 0) {
      return notFoundError(c, `Diff item ${id} not found`);
    }
    return c.json(rows[0]);
  })

  .post(
    "/sync",
    createSyncHandler({
      name: "framework-diff-items",
      table: frameworkDiffItems,
      batchSchema: SyncBatchSchema,
      toRow: (item, now) => ({
        ...item,
        syncedAt: now,
        updatedAt: now,
      }),
      conflictSet: {
        diffId: sql`excluded.diff_id`,
        changeType: sql`excluded.change_type`,
        riskDomainCanonical: sql`COALESCE(excluded.risk_domain_canonical, ${frameworkDiffItems.riskDomainCanonical})`,
        beforeSnapshot: sql`COALESCE(excluded.before_snapshot, ${frameworkDiffItems.beforeSnapshot})`,
        afterSnapshot: sql`COALESCE(excluded.after_snapshot, ${frameworkDiffItems.afterSnapshot})`,
        severity: sql`COALESCE(excluded.severity, ${frameworkDiffItems.severity})`,
        classifierTag: sql`COALESCE(excluded.classifier_tag, ${frameworkDiffItems.classifierTag})`,
        rationale: sql`COALESCE(excluded.rationale, ${frameworkDiffItems.rationale})`,
        syncedAt: sql`now()`,
        updatedAt: sql`now()`,
      },
      auditRecordType: "framework_diff_items",
    }),
  )

  .post("/delete-batch", deleteBatchHandler(frameworkDiffItems, "framework_diff_items"));

export const frameworkDiffItemsRoute = diffItemsApp;
export type FrameworkDiffItemsRoute = typeof diffItemsApp;
