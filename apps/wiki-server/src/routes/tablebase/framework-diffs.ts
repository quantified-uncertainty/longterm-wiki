/**
 * framework_diffs (QUA-691 Phase 4).
 *
 * Version-pair diff aggregate. `review_verdict` defaults to 'unreviewed'
 * and public UI must gate on `review_verdict IN ('confirmed_weakening',
 * 'nuanced', 'confirmed_strengthening')` before surfacing a weakening
 * flag publicly.
 */

import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, desc, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { frameworkDiffs } from "../../schema.js";
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

const VALID_OVERALL = ["weaker", "stronger", "mixed", "neutral", "rewrite"] as const;
const VALID_VERDICT = [
  "confirmed_weakening",
  "confirmed_strengthening",
  "false_positive",
  "nuanced",
  "unreviewed",
] as const;

const AllQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 200),
  offset: z.coerce.number().int().min(0).default(0),
  from_version_id: z.string().max(200).optional(),
  to_version_id: z.string().max(200).optional(),
  weakening_flagged: z.coerce.boolean().optional(),
  review_verdict: z.enum(VALID_VERDICT).optional(),
});

const SyncItemSchema = z.object({
  id: z.string().regex(
    /^[A-Za-z0-9_-]{10}$/,
    "id must be 10 alphanumeric characters (hyphens and underscores allowed)",
  ),
  fromVersionId: z.string().min(1).max(200),
  toVersionId: z.string().min(1).max(200),
  changeSummary: z.string().min(1).max(5000),
  weakeningFlagged: z.boolean().optional(),
  strengtheningFlagged: z.boolean().optional(),
  neutralChangesCount: z.number().int().nonnegative().nullable().optional(),
  diffDetails: z.record(z.unknown()).nullable().optional(),
  overallDirection: z.enum(VALID_OVERALL).nullable().optional(),
  humanReviewed: z.boolean().optional(),
  reviewVerdict: z.enum(VALID_VERDICT).optional(),
  reviewNotes: z.string().max(5000).nullable().optional(),
  classifiedByModel: z.string().max(200).nullable().optional(),
});

const SyncBatchSchema = z.object({
  items: z
    .array(SyncItemSchema)
    .min(1)
    .max(500)
    .refine(noDuplicateIds, { message: "Duplicate id values in items array" }),
});

const diffsApp = new Hono()

  .get("/stats", async (c) => {
    const db = getDrizzleDb();
    const [row] = await db
      .select({
        total: count(),
        weakenings: sql<number>`count(*) filter (where ${frameworkDiffs.weakeningFlagged})`,
        strengthenings: sql<number>`count(*) filter (where ${frameworkDiffs.strengtheningFlagged})`,
        reviewed: sql<number>`count(*) filter (where ${frameworkDiffs.humanReviewed})`,
        confirmedWeakenings: sql<number>`count(*) filter (where ${frameworkDiffs.reviewVerdict} = 'confirmed_weakening')`,
      })
      .from(frameworkDiffs);
    return c.json({
      total: row.total,
      weakenings: Number(row.weakenings),
      strengthenings: Number(row.strengthenings),
      reviewed: Number(row.reviewed),
      confirmedWeakenings: Number(row.confirmedWeakenings),
    });
  })

  .get("/all", zv("query", AllQuery), async (c) => {
    const {
      limit, offset,
      from_version_id, to_version_id,
      weakening_flagged, review_verdict,
    } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions: SQL[] = [];
    if (from_version_id) conditions.push(eq(frameworkDiffs.fromVersionId, from_version_id));
    if (to_version_id) conditions.push(eq(frameworkDiffs.toVersionId, to_version_id));
    if (weakening_flagged !== undefined)
      conditions.push(eq(frameworkDiffs.weakeningFlagged, weakening_flagged));
    if (review_verdict) conditions.push(eq(frameworkDiffs.reviewVerdict, review_verdict));

    const where =
      conditions.length === 0
        ? undefined
        : conditions.length === 1
          ? conditions[0]
          : and(...conditions);

    const { rows, total } = await paginatedQuery({
      query: db
        .select()
        .from(frameworkDiffs)
        .where(where)
        .orderBy(desc(frameworkDiffs.createdAt))
        .limit(limit)
        .offset(offset),
      countQuery: db
        .select({ count: count() })
        .from(frameworkDiffs)
        .where(where),
      formatRow: (r: typeof frameworkDiffs.$inferSelect) => r,
    });

    return c.json({ items: rows, total, limit, offset });
  })

  .get("/by-version-pair/:fromId/:toId", async (c) => {
    const fromId = c.req.param("fromId");
    const toId = c.req.param("toId");
    const db = getDrizzleDb();
    const rows = await db
      .select()
      .from(frameworkDiffs)
      .where(
        and(
          eq(frameworkDiffs.fromVersionId, fromId),
          eq(frameworkDiffs.toVersionId, toId),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      return notFoundError(c, `Diff ${fromId} → ${toId} not found`);
    }
    return c.json(rows[0]);
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
      .from(frameworkDiffs)
      .where(eq(frameworkDiffs.id, id))
      .limit(1);
    if (rows.length === 0) {
      return notFoundError(c, `Diff ${id} not found`);
    }
    return c.json(rows[0]);
  })

  .post(
    "/sync",
    createSyncHandler({
      name: "framework-diffs",
      table: frameworkDiffs,
      batchSchema: SyncBatchSchema,
      naturalKey: (item) => `${item.fromVersionId}|${item.toVersionId}`,
      toRow: (item, now) => ({
        ...item,
        weakeningFlagged: item.weakeningFlagged ?? false,
        strengtheningFlagged: item.strengtheningFlagged ?? false,
        humanReviewed: item.humanReviewed ?? false,
        reviewVerdict: item.reviewVerdict ?? "unreviewed",
        syncedAt: now,
        updatedAt: now,
      }),
      conflictSet: {
        fromVersionId: sql`excluded.from_version_id`,
        toVersionId: sql`excluded.to_version_id`,
        changeSummary: sql`excluded.change_summary`,
        weakeningFlagged: sql`excluded.weakening_flagged`,
        strengtheningFlagged: sql`excluded.strengthening_flagged`,
        neutralChangesCount: sql`COALESCE(excluded.neutral_changes_count, ${frameworkDiffs.neutralChangesCount})`,
        diffDetails: sql`COALESCE(excluded.diff_details, ${frameworkDiffs.diffDetails})`,
        overallDirection: sql`COALESCE(excluded.overall_direction, ${frameworkDiffs.overallDirection})`,
        humanReviewed: sql`excluded.human_reviewed`,
        reviewVerdict: sql`excluded.review_verdict`,
        reviewNotes: sql`COALESCE(excluded.review_notes, ${frameworkDiffs.reviewNotes})`,
        classifiedByModel: sql`COALESCE(excluded.classified_by_model, ${frameworkDiffs.classifiedByModel})`,
        syncedAt: sql`now()`,
        updatedAt: sql`now()`,
      },
      auditRecordType: "framework_diffs",
      toThing: (item) => ({
        id: item.id,
        thingType: "framework-diff" as const,
        parentThingId: item.toVersionId,
        sourceTable: "framework_diffs",
        sourceId: item.id,
      }),
    }),
  )

  .post("/delete-batch", deleteBatchHandler(frameworkDiffs, "framework_diffs"));

export const frameworkDiffsRoute = diffsApp;
export type FrameworkDiffsRoute = typeof diffsApp;
