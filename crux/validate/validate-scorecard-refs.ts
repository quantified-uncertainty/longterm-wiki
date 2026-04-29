#!/usr/bin/env node

/**
 * Scorecard data integrity (QUA-688 Phase 1).
 *
 * Two checks against the wiki-server's `/api/scorecard-*` endpoints:
 *
 *   1. **is_latest invariant** — at most one snapshot per `scorecardSource`
 *      has `isLatest=true`. The PG partial unique index enforces this at
 *      the storage layer, but a client validator catches drift earlier.
 *   2. **Entity reference resolution** — every `entity_id` on a
 *      `scorecard_grades` row resolves to a PG entity. The `entity_id` FK
 *      already points at `entities.stable_id`, but if an entity is later
 *      pruned, ON DELETE CASCADE removes the grade — so this check is
 *      really catching the bypass of "soft-orphan" rows where the
 *      entities row was renamed but its stable_id remained.
 *
 * Network dependency: skips silently when wiki-server is unreachable
 * (advisory tier — we'd rather miss a check than fail PRs offline).
 *
 * Usage:
 *   npx tsx crux/validate/validate-scorecard-refs.ts
 *   npx tsx crux/validate/validate-scorecard-refs.ts --ci
 *
 * Exit codes:
 *   0 = All checks pass (or server unreachable)
 *   1 = Invariant violation found
 */

import { fileURLToPath } from "url";
import { getColors } from "../lib/output.ts";
import { apiRequest, type ApiResult } from "../lib/wiki-server/client.ts";
import type { ValidatorResult, ValidatorOptions } from "./types.ts";

interface SnapshotRow {
  id: string;
  scorecardSource: string;
  isLatest: boolean;
  publishedAt: string;
}

interface GradeRow {
  id: string;
  snapshotId: string;
  scorecardSource: string | null;
  entityId: string;
  entityDisplayName: string;
  dimensionSlug: string;
}

interface SnapshotsResponse {
  items: SnapshotRow[];
  total: number;
}

interface GradesResponse {
  items: GradeRow[];
  total: number;
}

interface EntityRow {
  id: string;
  stableId: string | null;
}

interface EntitiesResponse {
  entities: EntityRow[];
  total: number;
  limit: number;
  offset: number;
}

async function fetchAllSnapshots(): Promise<ApiResult<SnapshotRow[]>> {
  // Only is_latest=true rows are relevant to the is_latest invariant. At most
  // one per source, so 200 is a generous cap (5 sources × ~few waves max).
  // typed-client-ok: QUA-770 baseline — validator script, direct typing acceptable for ad-hoc integrity queries
  const result = await apiRequest<SnapshotsResponse>(
    "GET",
    `/api/scorecard-snapshots/all?latest=true&limit=200`,
  );
  if (!result.ok) return result;
  return { ok: true, data: result.data.items };
}

async function fetchAllGrades(): Promise<ApiResult<GradeRow[]>> {
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 50; // 50,000-row safety cap
  const all: GradeRow[] = [];
  let offset = 0;
  let total = Infinity;

  for (let i = 0; i < MAX_PAGES && offset < total; i++) {
    // typed-client-ok: QUA-770 baseline — validator script, direct typing acceptable for ad-hoc integrity queries
    const result = await apiRequest<GradesResponse>(
      "GET",
      `/api/scorecard-grades/all?limit=${PAGE_SIZE}&offset=${offset}`,
    );
    if (!result.ok) return result;
    all.push(...result.data.items);
    total = result.data.total;
    offset += PAGE_SIZE;
  }
  return { ok: true, data: all };
}

async function fetchAllEntityStableIds(): Promise<ApiResult<Set<string>>> {
  const PAGE_SIZE = 500;
  const MAX_PAGES = 100;
  const stableIds = new Set<string>();
  let offset = 0;
  let total = Infinity;

  for (let i = 0; i < MAX_PAGES && offset < total; i++) {
    // typed-client-ok: QUA-770 baseline — validator script, direct typing acceptable for ad-hoc integrity queries
    const result = await apiRequest<EntitiesResponse>(
      "GET",
      `/api/entities?limit=${PAGE_SIZE}&offset=${offset}`,
    );
    if (!result.ok) return result;
    for (const e of result.data.entities) {
      if (e.stableId) stableIds.add(e.stableId);
    }
    total = result.data.total;
    // Use the response's actual limit rather than PAGE_SIZE — defensive
    // against silent server-side clamping (e.g. if maxLimit shrinks).
    offset += result.data.limit ?? PAGE_SIZE;
  }
  return { ok: true, data: stableIds };
}

interface CheckResult {
  serverAvailable: boolean;
  snapshotCount: number;
  gradeCount: number;
  isLatestViolations: Array<{ source: string; snapshotIds: string[] }>;
  unresolvedEntityRefs: Array<{ id: string; entityId: string; entityDisplayName: string }>;
}

async function detect(): Promise<CheckResult> {
  const snapshots = await fetchAllSnapshots();
  if (!snapshots.ok) {
    return {
      serverAvailable: false,
      snapshotCount: 0,
      gradeCount: 0,
      isLatestViolations: [],
      unresolvedEntityRefs: [],
    };
  }

  // is_latest invariant
  const latestPerSource = new Map<string, string[]>();
  for (const s of snapshots.data) {
    if (!s.isLatest) continue;
    const list = latestPerSource.get(s.scorecardSource) ?? [];
    list.push(s.id);
    latestPerSource.set(s.scorecardSource, list);
  }
  const isLatestViolations: CheckResult["isLatestViolations"] = [];
  for (const [source, ids] of latestPerSource) {
    if (ids.length > 1) {
      isLatestViolations.push({ source, snapshotIds: ids });
    }
  }

  const grades = await fetchAllGrades();
  if (!grades.ok) {
    return {
      serverAvailable: true,
      snapshotCount: snapshots.data.length,
      gradeCount: 0,
      isLatestViolations,
      unresolvedEntityRefs: [],
    };
  }

  const entityIds = await fetchAllEntityStableIds();
  if (!entityIds.ok) {
    return {
      serverAvailable: true,
      snapshotCount: snapshots.data.length,
      gradeCount: grades.data.length,
      isLatestViolations,
      unresolvedEntityRefs: [],
    };
  }

  const unresolved: CheckResult["unresolvedEntityRefs"] = [];
  for (const g of grades.data) {
    if (!entityIds.data.has(g.entityId)) {
      unresolved.push({
        id: g.id,
        entityId: g.entityId,
        entityDisplayName: g.entityDisplayName,
      });
    }
  }

  return {
    serverAvailable: true,
    snapshotCount: snapshots.data.length,
    gradeCount: grades.data.length,
    isLatestViolations,
    unresolvedEntityRefs: unresolved,
  };
}

export async function runCheck(
  options: ValidatorOptions = {},
): Promise<ValidatorResult> {
  const colors = getColors();
  const ciMode = options.ci ?? false;

  const result = await detect();

  if (!result.serverAvailable) {
    if (!ciMode) {
      console.log(
        `\n${colors.dim}  Wiki-server unreachable — skipping scorecard checks${colors.reset}`,
      );
    }
    return { passed: true, errors: 0, warnings: 0 };
  }

  if (ciMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `\n  Snapshots: ${result.snapshotCount}  ·  Grades: ${result.gradeCount}`,
    );

    if (result.isLatestViolations.length === 0) {
      console.log(
        `${colors.green}  ✓ is_latest invariant: at most one TRUE per source${colors.reset}`,
      );
    } else {
      console.log(
        `${colors.red}  ✗ is_latest invariant violated:${colors.reset}`,
      );
      for (const v of result.isLatestViolations) {
        console.log(
          `    ${colors.red}${v.source}${colors.reset}: ${v.snapshotIds.join(", ")}`,
        );
      }
    }

    if (result.unresolvedEntityRefs.length === 0) {
      console.log(
        `${colors.green}  ✓ Every grade entity_id resolves to an entities row${colors.reset}`,
      );
    } else {
      console.log(
        `${colors.red}  ✗ ${result.unresolvedEntityRefs.length} grade rows reference unknown entity:${colors.reset}`,
      );
      for (const u of result.unresolvedEntityRefs.slice(0, 20)) {
        console.log(
          `    ${colors.red}${u.id}${colors.reset} → ${u.entityId} (${u.entityDisplayName})`,
        );
      }
      if (result.unresolvedEntityRefs.length > 20) {
        console.log(
          `    ${colors.dim}... and ${result.unresolvedEntityRefs.length - 20} more${colors.reset}`,
        );
      }
    }
  }

  const errors =
    result.isLatestViolations.length + result.unresolvedEntityRefs.length;
  return { passed: errors === 0, errors, warnings: 0 };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const result = await runCheck({ ci: args.includes("--ci") });
  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("validate-scorecard-refs crashed:", err);
    process.exit(1);
  });
}
