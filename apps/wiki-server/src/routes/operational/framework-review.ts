/**
 * Framework Review (QUA-710 / Phase 4-C).
 *
 * Admin-only review workflow for the human-in-the-loop step of the
 * frontier safety framework tracker (QUA-691). Two queues:
 *
 *   1. Pending versions — `safety_framework_versions.ingest_status =
 *      'pending_review'`. The reviewer approves/edits/rejects each
 *      extracted threshold, then publishes (or rejects) the version.
 *
 *   2. Unreviewed diffs — `framework_diffs.review_verdict = 'unreviewed'`.
 *      The reviewer assigns a verdict (confirmed_weakening,
 *      false_positive, etc.). Public weakening UI must gate on the
 *      verdict — see `framework-diffs.ts` header.
 *
 * Verdict encoding for thresholds: the schema has only a boolean
 * `human_reviewed` column, so we prefix `human_review_notes` with a
 * machine-parsable tag — `[approved]`, `[rejected] <why>`, `[skip] <why>`,
 * `[edited] <notes>`. Helpers below own that encoding so callers never
 * see the raw string format.
 *
 * Mutations are written inside a transaction and audit-logged via
 * `logAuditEntries()` so reviewer actions show up in the standard
 * tablebase audit trail (record types `framework_capability_thresholds`,
 * `safety_framework_versions`, `framework_diffs`).
 */

import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, sql, inArray } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import {
  safetyFrameworks,
  safetyFrameworkVersions,
  frameworkCapabilityThresholds,
  frameworkDiffs,
  frameworkDiffItems,
} from "../../schema.js";
import { logAuditEntries } from "../tablebase/audit-log.js";
import { applyAuditContext } from "../../middleware/audit-context.js";
import {
  zv,
  notFoundError,
  validationError,
} from "../shared/utils.js";

// ─── Verdict encoding helpers ─────────────────────────────────────────────

const VERDICT_TAGS = ["approved", "rejected", "skip", "edited"] as const;
type ThresholdVerdict = (typeof VERDICT_TAGS)[number];

// `[\s\S]` instead of `.` so notes can contain newlines without needing
// the `s` (dotAll) flag — that flag is ES2018+ and apps/web still targets
// ES2017. Equivalent semantics, broader runtime support.
const VERDICT_PREFIX_RE = /^\[(approved|rejected|skip|edited)\](?:\s+([\s\S]*))?$/;

/** Read the verdict tag (if any) from a `humanReviewNotes` string. */
export function parseThresholdVerdict(
  notes: string | null,
): { verdict: ThresholdVerdict; notes: string | null } | null {
  if (!notes) return null;
  const match = notes.match(VERDICT_PREFIX_RE);
  if (!match) return null;
  return {
    verdict: match[1] as ThresholdVerdict,
    notes: match[2] ?? null,
  };
}

/** Encode a verdict + free-text notes back into the `humanReviewNotes` string. */
export function formatThresholdNotes(
  verdict: ThresholdVerdict,
  notes: string | null | undefined,
): string {
  const trimmed = notes?.trim();
  return trimmed ? `[${verdict}] ${trimmed}` : `[${verdict}]`;
}

// ─── Schemas ──────────────────────────────────────────────────────────────

const VALID_RISK_DOMAINS = [
  "cbrn", "bio", "chem", "nuclear", "radiological",
  "cyber", "autonomy_replication", "ai_rd",
  "scheming", "persuasion", "loss_of_control", "other",
] as const;

const VALID_COMMITMENT_LANG = [
  "committed", "aspirational", "conditional", "informational",
] as const;

const VALID_DIFF_VERDICTS = [
  "confirmed_weakening",
  "confirmed_strengthening",
  "false_positive",
  "nuanced",
] as const;

const ThresholdReviewBody = z.object({
  verdict: z.enum(VERDICT_TAGS),
  notes: z.string().max(2000).nullable().optional(),
  edits: z
    .object({
      triggerDescription: z.string().min(1).max(5000).optional(),
      sourceQuote: z.string().min(1).max(5000).optional(),
      sourcePageHint: z.string().max(200).nullable().optional(),
      tierLabel: z.string().min(1).max(200).optional(),
      tierSortOrder: z.number().int().min(1).max(5).optional(),
      riskDomainCanonical: z.enum(VALID_RISK_DOMAINS).optional(),
      riskDomainLabel: z.string().min(1).max(200).optional(),
      commitmentLanguage: z.enum(VALID_COMMITMENT_LANG).nullable().optional(),
    })
    .optional(),
});

const PublishVersionBody = z.object({
  verdict: z.enum(["published", "rejected"]),
  notes: z.string().max(2000).nullable().optional(),
});

const DiffReviewBody = z.object({
  verdict: z.enum(VALID_DIFF_VERDICTS),
  notes: z.string().max(2000).nullable().optional(),
});

const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
function validId(id: string): boolean {
  return ID_RE.test(id);
}

// ─── Route ────────────────────────────────────────────────────────────────

const frameworkReviewApp = new Hono()

  // Versions awaiting review, with framework info + threshold counts.
  .get("/pending-versions", async (c) => {
    const db = getDrizzleDb();

    // Aggregate threshold counts per pending version. Total, plus a
    // reviewed-count derived from the verdict-prefix encoding.
    const pendingVersions = await db
      .select({
        id: safetyFrameworkVersions.id,
        frameworkId: safetyFrameworkVersions.frameworkId,
        versionLabel: safetyFrameworkVersions.versionLabel,
        publishedDate: safetyFrameworkVersions.publishedDate,
        discoveredDate: safetyFrameworkVersions.discoveredDate,
        sourceUrl: safetyFrameworkVersions.sourceUrl,
        waybackSnapshotUrl: safetyFrameworkVersions.waybackSnapshotUrl,
        pdfArchiveUrl: safetyFrameworkVersions.pdfArchiveUrl,
        summary: safetyFrameworkVersions.summary,
        contentLengthChars: safetyFrameworkVersions.contentLengthChars,
        ingestStatus: safetyFrameworkVersions.ingestStatus,
        createdAt: safetyFrameworkVersions.createdAt,
        frameworkName: safetyFrameworks.name,
        frameworkShortName: safetyFrameworks.shortName,
        orgDisplayName: safetyFrameworks.orgDisplayName,
      })
      .from(safetyFrameworkVersions)
      .leftJoin(
        safetyFrameworks,
        eq(safetyFrameworks.id, safetyFrameworkVersions.frameworkId),
      )
      .where(eq(safetyFrameworkVersions.ingestStatus, "pending_review"))
      .orderBy(safetyFrameworkVersions.discoveredDate);

    if (pendingVersions.length === 0) {
      return c.json({ versions: [] });
    }

    const versionIds = pendingVersions.map((v) => v.id);

    const thresholdCounts = await db
      .select({
        versionId: frameworkCapabilityThresholds.versionId,
        total: count(),
        reviewed: sql<number>`count(*) filter (where ${frameworkCapabilityThresholds.humanReviewed})`,
      })
      .from(frameworkCapabilityThresholds)
      .where(inArray(frameworkCapabilityThresholds.versionId, versionIds))
      .groupBy(frameworkCapabilityThresholds.versionId);

    const countsByVersion = new Map(
      thresholdCounts.map((r) => [r.versionId, r]),
    );

    return c.json({
      versions: pendingVersions.map((v) => {
        const counts = countsByVersion.get(v.id);
        const total = counts ? Number(counts.total) : 0;
        const reviewed = counts ? Number(counts.reviewed) : 0;
        return {
          ...v,
          thresholdCount: total,
          thresholdsReviewed: reviewed,
          allThresholdsReviewed: total > 0 && reviewed === total,
        };
      }),
    });
  })

  // Full review payload for one version: framework + thresholds with parsed verdicts.
  .get("/version/:id", async (c) => {
    const id = c.req.param("id");
    if (!validId(id)) return validationError(c, "Invalid version id");
    const db = getDrizzleDb();

    const versionRows = await db
      .select({
        version: safetyFrameworkVersions,
        framework: safetyFrameworks,
      })
      .from(safetyFrameworkVersions)
      .leftJoin(
        safetyFrameworks,
        eq(safetyFrameworks.id, safetyFrameworkVersions.frameworkId),
      )
      .where(eq(safetyFrameworkVersions.id, id))
      .limit(1);

    if (versionRows.length === 0) {
      return notFoundError(c, `Framework version ${id} not found`);
    }

    const thresholds = await db
      .select()
      .from(frameworkCapabilityThresholds)
      .where(eq(frameworkCapabilityThresholds.versionId, id))
      .orderBy(
        frameworkCapabilityThresholds.tierSortOrder,
        frameworkCapabilityThresholds.riskDomainCanonical,
      );

    const enriched = thresholds.map((t) => {
      const parsed = parseThresholdVerdict(t.humanReviewNotes);
      return {
        ...t,
        extractionConfidence:
          t.extractionConfidence == null ? null : Number(t.extractionConfidence),
        reviewVerdict: parsed?.verdict ?? null,
        reviewNotes: parsed?.notes ?? null,
      };
    });

    return c.json({
      version: versionRows[0].version,
      framework: versionRows[0].framework,
      thresholds: enriched,
    });
  })

  // Approve / edit / reject / skip a single threshold.
  .post(
    "/threshold/:id",
    zv("json", ThresholdReviewBody),
    async (c) => {
      const id = c.req.param("id");
      if (!validId(id)) return validationError(c, "Invalid threshold id");
      const body = c.req.valid("json");
      const db = getDrizzleDb();

      const existingRows = await db
        .select()
        .from(frameworkCapabilityThresholds)
        .where(eq(frameworkCapabilityThresholds.id, id))
        .limit(1);

      if (existingRows.length === 0) {
        return notFoundError(c, `Threshold ${id} not found`);
      }
      const existing = existingRows[0];

      // Edits without 'edited' verdict are a contradiction — reject early.
      if (body.edits && Object.keys(body.edits).length > 0 && body.verdict !== "edited") {
        return validationError(
          c,
          "edits provided but verdict is not 'edited'",
        );
      }

      const reviewNotes = formatThresholdNotes(body.verdict, body.notes);

      const updated = await db.transaction(async (tx) => {
        await applyAuditContext(tx, c);

        const updateValues: Record<string, unknown> = {
          humanReviewed: true,
          humanReviewNotes: reviewNotes,
          updatedAt: new Date(),
        };
        if (body.verdict === "edited" && body.edits) {
          for (const [k, v] of Object.entries(body.edits)) {
            if (v !== undefined) updateValues[k] = v;
          }
        }

        const rows = await tx
          .update(frameworkCapabilityThresholds)
          .set(updateValues)
          .where(eq(frameworkCapabilityThresholds.id, id))
          .returning();

        if (rows.length > 0) {
          await logAuditEntries(tx, [
            {
              recordType: "framework_capability_thresholds",
              recordId: id,
              operation: "update",
              oldData: { ...existing },
              newData: { ...rows[0] },
              verdict: body.verdict,
            },
          ]);
        }

        return rows[0];
      });

      const parsed = parseThresholdVerdict(updated.humanReviewNotes);
      return c.json({
        ok: true,
        threshold: {
          ...updated,
          extractionConfidence:
            updated.extractionConfidence == null
              ? null
              : Number(updated.extractionConfidence),
          reviewVerdict: parsed?.verdict ?? null,
          reviewNotes: parsed?.notes ?? null,
        },
      });
    },
  )

  // Publish (or reject) a version. Requires every threshold to have been touched.
  .post(
    "/version/:id/publish",
    zv("json", PublishVersionBody),
    async (c) => {
      const id = c.req.param("id");
      if (!validId(id)) return validationError(c, "Invalid version id");
      const body = c.req.valid("json");
      const db = getDrizzleDb();

      const versionRows = await db
        .select()
        .from(safetyFrameworkVersions)
        .where(eq(safetyFrameworkVersions.id, id))
        .limit(1);

      if (versionRows.length === 0) {
        return notFoundError(c, `Framework version ${id} not found`);
      }
      const existing = versionRows[0];

      if (existing.ingestStatus !== "pending_review") {
        return validationError(
          c,
          `Version is already ${existing.ingestStatus}; cannot re-publish`,
        );
      }

      // Publish requires every threshold reviewed. Reject can short-circuit.
      if (body.verdict === "published") {
        const [counts] = await db
          .select({
            total: count(),
            reviewed: sql<number>`count(*) filter (where ${frameworkCapabilityThresholds.humanReviewed})`,
          })
          .from(frameworkCapabilityThresholds)
          .where(eq(frameworkCapabilityThresholds.versionId, id));

        const total = Number(counts?.total ?? 0);
        const reviewed = Number(counts?.reviewed ?? 0);
        if (total === 0 || reviewed !== total) {
          return validationError(
            c,
            `Cannot publish: ${reviewed}/${total} thresholds reviewed`,
          );
        }
      }

      const updated = await db.transaction(async (tx) => {
        await applyAuditContext(tx, c);

        const rows = await tx
          .update(safetyFrameworkVersions)
          .set({
            ingestStatus: body.verdict,
            updatedAt: new Date(),
          })
          .where(eq(safetyFrameworkVersions.id, id))
          .returning();

        if (rows.length > 0) {
          await logAuditEntries(tx, [
            {
              recordType: "safety_framework_versions",
              recordId: id,
              operation: "update",
              oldData: { ...existing },
              newData: { ...rows[0] },
              verdict: body.verdict,
              evidence: body.notes ?? null,
            },
          ]);
        }

        // Bump the parent framework's latest_version_id only on a real publish.
        if (body.verdict === "published") {
          await tx
            .update(safetyFrameworks)
            .set({
              latestVersionId: id,
              updatedAt: new Date(),
            })
            .where(eq(safetyFrameworks.id, existing.frameworkId));
        }

        return rows[0];
      });

      return c.json({ ok: true, version: updated });
    },
  )

  // Diffs awaiting reviewer verdict, with version + framework labels.
  .get("/unreviewed-diffs", async (c) => {
    const db = getDrizzleDb();

    // Two-query strategy: one for diffs, then a single batched lookup of
    // every referenced version + framework. Self-joining
    // safety_framework_versions twice to alias from/to in one SQL would
    // need either Drizzle's `alias()` (heavier setup) or raw SQL — the
    // batched approach is cheaper and the row count is small (~22 diffs
    // pending at most, each pointing at 2 versions).
    const diffs = await db
      .select()
      .from(frameworkDiffs)
      .where(eq(frameworkDiffs.reviewVerdict, "unreviewed"))
      .orderBy(frameworkDiffs.createdAt);

    if (diffs.length === 0) {
      return c.json({ diffs: [] });
    }

    const versionIds = Array.from(
      new Set(diffs.flatMap((d) => [d.fromVersionId, d.toVersionId])),
    );

    const versions = await db
      .select({
        id: safetyFrameworkVersions.id,
        frameworkId: safetyFrameworkVersions.frameworkId,
        versionLabel: safetyFrameworkVersions.versionLabel,
        publishedDate: safetyFrameworkVersions.publishedDate,
      })
      .from(safetyFrameworkVersions)
      .where(inArray(safetyFrameworkVersions.id, versionIds));

    const versionMap = new Map(versions.map((v) => [v.id, v]));

    const frameworkIds = Array.from(
      new Set(versions.map((v) => v.frameworkId).filter((x): x is string => !!x)),
    );

    const frameworks = frameworkIds.length
      ? await db
          .select({
            id: safetyFrameworks.id,
            name: safetyFrameworks.name,
            shortName: safetyFrameworks.shortName,
            orgDisplayName: safetyFrameworks.orgDisplayName,
          })
          .from(safetyFrameworks)
          .where(inArray(safetyFrameworks.id, frameworkIds))
      : [];

    const frameworkMap = new Map(frameworks.map((f) => [f.id, f]));

    const itemCounts = await db
      .select({
        diffId: frameworkDiffItems.diffId,
        total: count(),
      })
      .from(frameworkDiffItems)
      .where(
        inArray(
          frameworkDiffItems.diffId,
          diffs.map((d) => d.id),
        ),
      )
      .groupBy(frameworkDiffItems.diffId);

    const itemCountMap = new Map(
      itemCounts.map((r) => [r.diffId, Number(r.total)]),
    );

    return c.json({
      diffs: diffs.map((d) => {
        const fromVer = versionMap.get(d.fromVersionId);
        const toVer = versionMap.get(d.toVersionId);
        const framework = fromVer
          ? frameworkMap.get(fromVer.frameworkId)
          : null;
        return {
          ...d,
          fromVersion: fromVer ?? null,
          toVersion: toVer ?? null,
          framework: framework ?? null,
          itemCount: itemCountMap.get(d.id) ?? 0,
        };
      }),
    });
  })

  // Full diff payload for the review screen: items + version metadata.
  .get("/diff/:id", async (c) => {
    const id = c.req.param("id");
    if (!validId(id)) return validationError(c, "Invalid diff id");
    const db = getDrizzleDb();

    const diffRows = await db
      .select()
      .from(frameworkDiffs)
      .where(eq(frameworkDiffs.id, id))
      .limit(1);

    if (diffRows.length === 0) {
      return notFoundError(c, `Diff ${id} not found`);
    }
    const diff = diffRows[0];

    const items = await db
      .select()
      .from(frameworkDiffItems)
      .where(eq(frameworkDiffItems.diffId, id))
      .orderBy(frameworkDiffItems.changeType);

    const versionIds = [diff.fromVersionId, diff.toVersionId];
    const versions = await db
      .select({
        id: safetyFrameworkVersions.id,
        frameworkId: safetyFrameworkVersions.frameworkId,
        versionLabel: safetyFrameworkVersions.versionLabel,
        publishedDate: safetyFrameworkVersions.publishedDate,
        sourceUrl: safetyFrameworkVersions.sourceUrl,
        waybackSnapshotUrl: safetyFrameworkVersions.waybackSnapshotUrl,
      })
      .from(safetyFrameworkVersions)
      .where(inArray(safetyFrameworkVersions.id, versionIds));

    const fromVersion = versions.find((v) => v.id === diff.fromVersionId) ?? null;
    const toVersion = versions.find((v) => v.id === diff.toVersionId) ?? null;

    const frameworkId = fromVersion?.frameworkId ?? toVersion?.frameworkId ?? null;
    const frameworkRows = frameworkId
      ? await db
          .select()
          .from(safetyFrameworks)
          .where(eq(safetyFrameworks.id, frameworkId))
          .limit(1)
      : [];

    return c.json({
      diff,
      items,
      fromVersion,
      toVersion,
      framework: frameworkRows[0] ?? null,
    });
  })

  // Confirm / mark false-positive / mark nuanced — sets reviewVerdict.
  .post(
    "/diff/:id",
    zv("json", DiffReviewBody),
    async (c) => {
      const id = c.req.param("id");
      if (!validId(id)) return validationError(c, "Invalid diff id");
      const body = c.req.valid("json");
      const db = getDrizzleDb();

      const existingRows = await db
        .select()
        .from(frameworkDiffs)
        .where(eq(frameworkDiffs.id, id))
        .limit(1);

      if (existingRows.length === 0) {
        return notFoundError(c, `Diff ${id} not found`);
      }
      const existing = existingRows[0];

      const updated = await db.transaction(async (tx) => {
        await applyAuditContext(tx, c);

        const rows = await tx
          .update(frameworkDiffs)
          .set({
            humanReviewed: true,
            reviewVerdict: body.verdict,
            reviewNotes: body.notes ?? null,
            updatedAt: new Date(),
          })
          .where(eq(frameworkDiffs.id, id))
          .returning();

        if (rows.length > 0) {
          await logAuditEntries(tx, [
            {
              recordType: "framework_diffs",
              recordId: id,
              operation: "update",
              oldData: { ...existing },
              newData: { ...rows[0] },
              verdict: body.verdict,
              evidence: body.notes ?? null,
            },
          ]);
        }

        return rows[0];
      });

      return c.json({ ok: true, diff: updated });
    },
  )

  // Aggregate stats for the dashboard header.
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const [versionStats] = await db
      .select({
        pendingVersions: sql<number>`count(*) filter (where ${safetyFrameworkVersions.ingestStatus} = 'pending_review')`,
        publishedVersions: sql<number>`count(*) filter (where ${safetyFrameworkVersions.ingestStatus} = 'published')`,
        rejectedVersions: sql<number>`count(*) filter (where ${safetyFrameworkVersions.ingestStatus} = 'rejected')`,
      })
      .from(safetyFrameworkVersions);

    const [diffStats] = await db
      .select({
        unreviewedDiffs: sql<number>`count(*) filter (where ${frameworkDiffs.reviewVerdict} = 'unreviewed')`,
        confirmedWeakenings: sql<number>`count(*) filter (where ${frameworkDiffs.reviewVerdict} = 'confirmed_weakening')`,
        falsePositives: sql<number>`count(*) filter (where ${frameworkDiffs.reviewVerdict} = 'false_positive')`,
      })
      .from(frameworkDiffs);

    return c.json({
      pendingVersions: Number(versionStats?.pendingVersions ?? 0),
      publishedVersions: Number(versionStats?.publishedVersions ?? 0),
      rejectedVersions: Number(versionStats?.rejectedVersions ?? 0),
      unreviewedDiffs: Number(diffStats?.unreviewedDiffs ?? 0),
      confirmedWeakenings: Number(diffStats?.confirmedWeakenings ?? 0),
      falsePositives: Number(diffStats?.falsePositives ?? 0),
    });
  });

export const frameworkReviewRoute = frameworkReviewApp;
export type FrameworkReviewRoute = typeof frameworkReviewApp;
