import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, desc } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import {
  scorecardGrades,
  scorecardSnapshots,
  entities,
  sourceVerdicts,
} from "../../schema.js";
import { zv, clampedLimit, qBool } from "../shared/utils.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import {
  verdictJoinCondition,
  verdictSelectFields,
  formatSourcing,
  type VerdictJoinFields,
} from "../shared/sourcing-join.js";
import { createSyncHandler } from "./sync-factory.js";

/**
 * Record-type identifier for `source_check_verdicts.record_type`.
 *
 * Singular, matching the existing convention (`personnel`, `grant`,
 * `division`, etc.). Renders the `SourcingDot` on `/scorecards` matrix
 * cells and on the org-tab scorecards panels.
 *
 * Verdict generation is out of scope for QUA-839 — all grades currently
 * have no row here, so the dot renders in `not_run` (white) state.
 */
const SCORECARD_GRADE_RECORD_TYPE = "scorecard_grade";

// ---- Constants ----

const MAX_PAGE_SIZE = 1000;

// ---- Query schemas ----

const AllQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 200),
  offset: z.coerce.number().int().min(0).default(0),
  snapshotId: z.string().max(100).optional(),
  entityId: z.string().max(200).optional(),
  scorecardSource: z.string().max(50).optional(),
  latest: qBool.optional(),
  // overall=true filters to the per-org rollup row only. Lets the
  // /scorecards directory pull one cell per (org, source) without
  // scanning thousands of FMTI indicator rows just to throw them away
  // client-side.
  overall: qBool.optional(),
});

// ---- Sync schema ----

const SyncScorecardGradesItemSchema = z.object({
  id: z.string().min(1).max(300),
  snapshotId: z.string().min(1).max(100),
  entityId: z.string().min(1).max(200),
  entityDisplayName: z.string().min(1).max(500),
  dimensionSlug: z.string().min(1).max(200),
  dimensionLabel: z.string().min(1).max(500),
  dimensionWeight: z.number().min(0).max(1).nullable().optional(),
  dimensionParentSlug: z.string().max(200).nullable().optional(),
  scoreNumeric: z.number().min(-1000).max(10000).nullable().optional(),
  scoreLetter: z.string().max(50).nullable().optional(),
  scoreRaw: z.string().min(1).max(500),
  notes: z.string().max(5000).nullable().optional(),
  sourceUrl: z.string().max(2000).nullable().optional(),
});

// ---- Helpers ----

interface GradeRow extends VerdictJoinFields {
  grade: typeof scorecardGrades.$inferSelect;
  entityTitle: string | null;
  entitySlug: string | null;
  scorecardSource: string | null;
  publishedAt: string | null;
  isLatest: boolean | null;
  snapshotSourceUrl: string | null;
}

function formatRow(r: GradeRow) {
  const g = r.grade;
  return {
    id: g.id,
    snapshotId: g.snapshotId,
    scorecardSource: r.scorecardSource,
    publishedAt: r.publishedAt,
    isLatest: r.isLatest,
    entityId: g.entityId,
    entityDisplayName: g.entityDisplayName,
    entitySlug: r.entitySlug,
    entityTitle: r.entityTitle,
    dimensionSlug: g.dimensionSlug,
    dimensionLabel: g.dimensionLabel,
    dimensionWeight:
      g.dimensionWeight == null ? null : Number(g.dimensionWeight),
    dimensionParentSlug: g.dimensionParentSlug,
    scoreNumeric: g.scoreNumeric == null ? null : Number(g.scoreNumeric),
    scoreLetter: g.scoreLetter,
    scoreRaw: g.scoreRaw,
    notes: g.notes,
    sourceUrl: g.sourceUrl,
    // QUA-864: parent snapshot's sourceUrl used as fallback by the
    // sourcing orchestrator when a per-grade sourceUrl is missing.
    // Most grades inherit evidence from the wave's PDF/page rather than
    // having a unique deep-link.
    snapshotSourceUrl: r.snapshotSourceUrl,
    syncedAt: g.syncedAt,
    sourcing: formatSourcing(r),
  };
}

// ---- Route ----

const scorecardGradesApp = new Hono()
  // GET /all
  .get("/all", zv("query", AllQuery), async (c) => {
    const { limit, offset, snapshotId, entityId, scorecardSource, latest, overall } =
      c.req.valid("query");
    const db = getDrizzleDb();

    const conditions: SQL[] = [];
    if (snapshotId) conditions.push(eq(scorecardGrades.snapshotId, snapshotId));
    if (entityId) conditions.push(eq(scorecardGrades.entityId, entityId));
    if (scorecardSource)
      conditions.push(eq(scorecardSnapshots.scorecardSource, scorecardSource));
    if (latest !== undefined)
      conditions.push(eq(scorecardSnapshots.isLatest, latest));
    if (overall === true)
      conditions.push(eq(scorecardGrades.dimensionSlug, "overall"));

    const where = conditions.length ? and(...conditions) : undefined;

    const rows = await db
      .select({
        grade: scorecardGrades,
        entityTitle: entities.title,
        entitySlug: entities.id,
        scorecardSource: scorecardSnapshots.scorecardSource,
        publishedAt: scorecardSnapshots.publishedAt,
        isLatest: scorecardSnapshots.isLatest,
        snapshotSourceUrl: scorecardSnapshots.sourceUrl,
        ...verdictSelectFields,
      })
      .from(scorecardGrades)
      .leftJoin(
        scorecardSnapshots,
        eq(scorecardGrades.snapshotId, scorecardSnapshots.id),
      )
      .leftJoin(entities, eq(scorecardGrades.entityId, entities.stableId))
      .leftJoin(
        sourceVerdicts,
        verdictJoinCondition(
          SCORECARD_GRADE_RECORD_TYPE,
          scorecardGrades.id,
        ),
      )
      .where(where)
      .orderBy(
        desc(scorecardSnapshots.publishedAt),
        scorecardGrades.entityDisplayName,
        scorecardGrades.dimensionSlug,
      )
      .limit(limit)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: count() })
      .from(scorecardGrades)
      .leftJoin(
        scorecardSnapshots,
        eq(scorecardGrades.snapshotId, scorecardSnapshots.id),
      )
      .where(where);

    return c.json({
      items: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // GET /by-entity/:entityId — every grade for one org, latest snapshot per source
  .get("/by-entity/:entityId", async (c) => {
    const entityId = c.req.param("entityId");
    const db = getDrizzleDb();

    const rows = await db
      .select({
        grade: scorecardGrades,
        entityTitle: entities.title,
        entitySlug: entities.id,
        scorecardSource: scorecardSnapshots.scorecardSource,
        publishedAt: scorecardSnapshots.publishedAt,
        isLatest: scorecardSnapshots.isLatest,
        snapshotSourceUrl: scorecardSnapshots.sourceUrl,
        ...verdictSelectFields,
      })
      .from(scorecardGrades)
      .leftJoin(
        scorecardSnapshots,
        eq(scorecardGrades.snapshotId, scorecardSnapshots.id),
      )
      .leftJoin(entities, eq(scorecardGrades.entityId, entities.stableId))
      .leftJoin(
        sourceVerdicts,
        verdictJoinCondition(
          SCORECARD_GRADE_RECORD_TYPE,
          scorecardGrades.id,
        ),
      )
      .where(
        and(
          eq(scorecardGrades.entityId, entityId),
          eq(scorecardSnapshots.isLatest, true),
        ),
      )
      .orderBy(
        scorecardSnapshots.scorecardSource,
        scorecardGrades.dimensionSlug,
      );

    return c.json({ items: rows.map(formatRow), total: rows.length });
  })

  // POST /sync
  .post(
    "/sync",
    createSyncHandler({
      name: "scorecard-grades",
      table: scorecardGrades,
      syncSchema: SyncScorecardGradesItemSchema,
      entityRefs: ["entityId"],
      auditRecordType: "scorecard_grades",
      // Drizzle's numeric() insert type is `string`; the Zod schema emits
      // numbers. Coerce explicitly.
      toRow: (item, now) => ({
        id: item.id,
        snapshotId: item.snapshotId,
        entityId: item.entityId,
        entityDisplayName: item.entityDisplayName,
        dimensionSlug: item.dimensionSlug,
        dimensionLabel: item.dimensionLabel,
        dimensionWeight:
          item.dimensionWeight == null ? null : String(item.dimensionWeight),
        dimensionParentSlug: item.dimensionParentSlug ?? null,
        scoreNumeric:
          item.scoreNumeric == null ? null : String(item.scoreNumeric),
        scoreLetter: item.scoreLetter ?? null,
        scoreRaw: item.scoreRaw,
        notes: item.notes ?? null,
        sourceUrl: item.sourceUrl ?? null,
        syncedAt: now,
        updatedAt: now,
      }),
    }),
  )

  .post("/delete-batch", deleteBatchHandler(scorecardGrades, null, { maxIdLength: 300 }));

export const scorecardGradesRoute = scorecardGradesApp;
export type ScorecardGradesRoute = typeof scorecardGradesApp;
