/**
 * Shared sync engine — converts adapter output to API payloads and POSTs
 * to the wiki-server scorecard-snapshots / scorecard-grades endpoints.
 *
 * The factory-driven sync handlers on the server side handle upsert
 * semantics (ON CONFLICT DO UPDATE), so reruns are idempotent: the same
 * (snapshotId, entityId, dimensionSlug) tuple updates in place.
 *
 * Hard-failure rule (QUA-698): unresolved org names abort the sync —
 * never silently drop a row. The CLI `analyze` subcommand surfaces
 * unresolved names so they can be added to `data/scorecards/org-aliases.yaml`.
 */

import {
  syncScorecardSnapshots,
  type ScorecardSnapshotsSyncResult,
} from "../wiki-server/scorecard-snapshots.ts";
import {
  syncScorecardGrades,
  type ScorecardGradesSyncResult,
} from "../wiki-server/scorecard-grades.ts";
import { resolveOrg, type OrgResolverContext } from "./org-aliases.ts";
import type {
  RawSnapshot,
  RawGrade,
  ResolvedGrade,
  ScorecardSourceAdapter,
  SourceAnalysis,
} from "./types.ts";

/**
 * Resolve every grade in a snapshot, partitioning into resolved + unresolved.
 * Pure — no network calls. Used by both `analyze` (collects unresolved) and
 * `sync` (throws on unresolved).
 */
export function resolveSnapshot(
  ctx: OrgResolverContext,
  grades: RawGrade[],
): { resolved: ResolvedGrade[]; unresolved: string[] } {
  const resolved: ResolvedGrade[] = [];
  const unresolved = new Set<string>();
  for (const g of grades) {
    const m = resolveOrg(ctx, g.orgName);
    if (!m) {
      unresolved.add(g.orgName);
      continue;
    }
    resolved.push({
      raw: g,
      entityId: m.entityId,
      canonicalName: m.canonicalName,
    });
  }
  return { resolved, unresolved: [...unresolved].sort() };
}

/**
 * Build the snapshot payload for `/api/scorecard-snapshots/sync`.
 * Counts (orgCount, dimensionCount) are derived from the resolved grade
 * set so they reflect what we actually loaded, not what the source claims.
 */
export function snapshotToPayload(
  snapshot: RawSnapshot,
  resolved: ResolvedGrade[],
): Record<string, unknown> {
  const orgs = new Set<string>();
  const dimensions = new Set<string>();
  for (const r of resolved) {
    orgs.add(r.entityId);
    dimensions.add(r.raw.dimensionSlug);
  }
  return {
    id: snapshot.id,
    scorecardSource: snapshot.scorecardSource,
    waveLabel: snapshot.waveLabel,
    publishedAt: snapshot.publishedAt,
    sourceUrl: snapshot.sourceUrl,
    methodologyUrl: snapshot.methodologyUrl ?? null,
    license: snapshot.license ?? null,
    notes: snapshot.notes ?? null,
    orgCount: orgs.size,
    dimensionCount: dimensions.size,
    isLatest: snapshot.isLatest,
    sourceActive: snapshot.sourceActive,
  };
}

/**
 * Build a grade payload. Grade IDs are deterministic so reruns upsert
 * the same row: `<snapshotId>|<entityId>|<dimensionSlug>`. The pipe is
 * safe — none of the inputs may legally contain it (Zod max-length
 * caps are 100/200/200, and slugs are kebab-case alphanumerics).
 */
export function gradeToPayload(g: ResolvedGrade): Record<string, unknown> {
  const id = `${g.raw.snapshotId}|${g.entityId}|${g.raw.dimensionSlug}`;
  return {
    id,
    snapshotId: g.raw.snapshotId,
    entityId: g.entityId,
    entityDisplayName: g.canonicalName,
    dimensionSlug: g.raw.dimensionSlug,
    dimensionLabel: g.raw.dimensionLabel,
    dimensionWeight: g.raw.dimensionWeight ?? null,
    dimensionParentSlug: g.raw.dimensionParentSlug ?? null,
    scoreNumeric: g.raw.scoreNumeric ?? null,
    scoreLetter: g.raw.scoreLetter ?? null,
    scoreRaw: g.raw.scoreRaw,
    notes: g.raw.notes ?? null,
    sourceUrl: g.raw.sourceUrl ?? null,
  };
}

export interface SyncOptions {
  dryRun?: boolean;
  /** Print payloads (debug). */
  verbose?: boolean;
}

export interface SyncResult {
  source: string;
  snapshots: number;
  grades: number;
  snapshotResp?: ScorecardSnapshotsSyncResult;
  gradesResp?: ScorecardGradesSyncResult;
}

/**
 * Sync one source end-to-end: snapshots first (so grade FKs resolve),
 * then all grades for those snapshots. Aborts on any unresolved org.
 */
export async function syncSource(
  adapter: ScorecardSourceAdapter,
  ctx: OrgResolverContext,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const snapshots = adapter.listSnapshots();
  if (snapshots.length === 0) {
    return { source: adapter.source, snapshots: 0, grades: 0 };
  }

  // Resolve every grade up-front so we can hard-fail before any write.
  const allResolved: ResolvedGrade[] = [];
  for (const snap of snapshots) {
    const grades = adapter.parseGrades(snap);
    const { resolved, unresolved } = resolveSnapshot(ctx, grades);
    if (unresolved.length > 0) {
      throw new Error(
        `[${adapter.source}] unresolved org names in ${snap.id}:\n  ` +
          unresolved.map((n) => `- ${n}`).join("\n  ") +
          `\nAdd these to data/scorecards/org-aliases.yaml or to the entity's aliases:`,
      );
    }
    allResolved.push(...resolved);
  }

  // Group resolved grades by snapshot for payload counts.
  const bySnapshot = new Map<string, ResolvedGrade[]>();
  for (const r of allResolved) {
    const arr = bySnapshot.get(r.raw.snapshotId) ?? [];
    arr.push(r);
    bySnapshot.set(r.raw.snapshotId, arr);
  }

  const snapshotPayloads = snapshots.map((s) =>
    snapshotToPayload(s, bySnapshot.get(s.id) ?? []),
  );
  const gradePayloads = allResolved.map(gradeToPayload);

  if (opts.verbose) {
    console.log(JSON.stringify({ snapshotPayloads, gradePayloads }, null, 2));
  }
  if (opts.dryRun) {
    return {
      source: adapter.source,
      snapshots: snapshotPayloads.length,
      grades: gradePayloads.length,
    };
  }

  const snapResp = await syncScorecardSnapshots(snapshotPayloads);
  if (!snapResp.ok) {
    throw new Error(
      `[${adapter.source}] snapshot sync failed (${snapResp.error}): ${snapResp.message}`,
    );
  }
  const gradesResp = await syncScorecardGrades(gradePayloads);
  if (!gradesResp.ok) {
    throw new Error(
      `[${adapter.source}] grade sync failed (${gradesResp.error}): ${gradesResp.message}`,
    );
  }

  return {
    source: adapter.source,
    snapshots: snapshotPayloads.length,
    grades: gradePayloads.length,
    snapshotResp: snapResp.data,
    gradesResp: gradesResp.data,
  };
}

/**
 * Analyze a source without writing anything — used by the `analyze`
 * subcommand to surface unresolved org names + counts.
 */
export function analyzeSource(
  adapter: ScorecardSourceAdapter,
  ctx: OrgResolverContext,
): SourceAnalysis {
  const snapshots = adapter.listSnapshots();
  const orgs = new Set<string>();
  const allUnresolved = new Set<string>();
  let resolvedCount = 0;
  let totalGrades = 0;

  for (const snap of snapshots) {
    const grades = adapter.parseGrades(snap);
    totalGrades += grades.length;
    for (const g of grades) orgs.add(g.orgName);
    const { resolved, unresolved } = resolveSnapshot(ctx, grades);
    resolvedCount += resolved.length;
    for (const u of unresolved) allUnresolved.add(u);
  }

  return {
    source: adapter.source,
    snapshots: snapshots.length,
    grades: totalGrades,
    uniqueOrgs: orgs.size,
    resolved: resolvedCount,
    unresolved: [...allUnresolved].sort(),
  };
}
