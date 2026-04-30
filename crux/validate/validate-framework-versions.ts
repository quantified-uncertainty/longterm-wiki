#!/usr/bin/env node

/**
 * Frontier safety framework — version archival integrity (QUA-711 / QUA-706 Phase 4-D).
 *
 * Every `safety_framework_versions` row whose `ingest_status = 'published'`
 * must carry either:
 *   - `wayback_snapshot_url` populated (the Wayback push succeeded), OR
 *   - `notes` containing the substring "wayback" (case-insensitive),
 *     documenting why the push was skipped or failed.
 *
 * The framework fetch helper (`crux/frameworks/fetch.ts::fetchFramework`)
 * already returns a `note` field flagging Wayback fallback state ("Wayback
 * push failed or returned no snapshot", "Wayback push skipped"); the
 * weekly re-fetch script persists that to `safety_framework_versions.notes`.
 * This validator catches the case where a published version landed without
 * either: lab silently changed a CDN URL, archived nothing, and we have no
 * canonical reference for the cited content.
 *
 * Network dependency: skips silently when wiki-server is unreachable.
 *
 * Usage:
 *   npx tsx crux/validate/validate-framework-versions.ts
 *   npx tsx crux/validate/validate-framework-versions.ts --ci
 *
 * Exit codes:
 *   0 = All checks pass (or server unreachable, or no published rows yet)
 *   1 = Invariant violation found
 */

import { fileURLToPath } from "url";
import { getColors } from "../lib/output.ts";
import { apiRequest, type ApiResult } from "../lib/wiki-server/client.ts";
import type { ValidatorResult, ValidatorOptions } from "./types.ts";

interface VersionRow {
  id: string;
  frameworkId: string;
  versionLabel: string;
  ingestStatus: string;
  waybackSnapshotUrl: string | null;
  notes: string | null;
  sourceUrl: string;
}

interface VersionsResponse {
  items: VersionRow[];
  total: number;
  limit: number;
  offset: number;
}

async function fetchAllVersions(): Promise<ApiResult<VersionRow[]>> {
  const PAGE_SIZE = 500;
  const MAX_PAGES = 20;
  const all: VersionRow[] = [];
  let offset = 0;
  let total = Infinity;

  for (let i = 0; i < MAX_PAGES && offset < total; i++) {
    // typed-client-ok: QUA-770 baseline — validator script, direct typing acceptable for ad-hoc integrity queries
    const result = await apiRequest<VersionsResponse>(
      "GET",
      `/api/safety-framework-versions/all?limit=${PAGE_SIZE}&offset=${offset}`,
    );
    if (!result.ok) return result;
    all.push(...result.data.items);
    total = result.data.total;
    offset += result.data.limit ?? PAGE_SIZE;
  }
  return { ok: true, data: all };
}

interface Violation {
  id: string;
  frameworkId: string;
  versionLabel: string;
  sourceUrl: string;
}

interface CheckResult {
  serverAvailable: boolean;
  totalVersions: number;
  publishedVersions: number;
  violations: Violation[];
}

/**
 * Returns true when `notes` documents a Wayback fallback. The fetch helper
 * emits "Wayback push failed or returned no snapshot" or "Wayback push
 * skipped (skipWayback=true)" — a `wayback` substring is the lowest-noise
 * signal that the gap is intentional.
 */
export function notesFlagWaybackSkipped(notes: string | null): boolean {
  if (!notes) return false;
  return notes.toLowerCase().includes("wayback");
}

export function detectViolations(versions: VersionRow[]): Violation[] {
  const violations: Violation[] = [];
  for (const v of versions) {
    if (v.ingestStatus !== "published") continue;
    const hasWayback =
      typeof v.waybackSnapshotUrl === "string" &&
      v.waybackSnapshotUrl.length > 0;
    if (hasWayback) continue;
    if (notesFlagWaybackSkipped(v.notes)) continue;
    violations.push({
      id: v.id,
      frameworkId: v.frameworkId,
      versionLabel: v.versionLabel,
      sourceUrl: v.sourceUrl,
    });
  }
  return violations;
}

async function detect(): Promise<CheckResult> {
  const result = await fetchAllVersions();
  if (!result.ok) {
    return {
      serverAvailable: false,
      totalVersions: 0,
      publishedVersions: 0,
      violations: [],
    };
  }

  const versions = result.data;
  const publishedVersions = versions.filter(
    (v) => v.ingestStatus === "published",
  ).length;
  const violations = detectViolations(versions);

  return {
    serverAvailable: true,
    totalVersions: versions.length,
    publishedVersions,
    violations,
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
        `\n${colors.dim}  Wiki-server unreachable — skipping framework version checks${colors.reset}`,
      );
    }
    return { passed: true, errors: 0, warnings: 0 };
  }

  if (ciMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `\n  Versions: ${result.publishedVersions} published / ${result.totalVersions} total`,
    );
    if (result.violations.length === 0) {
      console.log(
        `${colors.green}  ✓ Every published version has wayback_snapshot_url OR notes flagging Wayback skipped${colors.reset}`,
      );
    } else {
      console.log(
        `${colors.red}  ✗ ${result.violations.length} published version(s) missing both wayback_snapshot_url and notes flag:${colors.reset}`,
      );
      for (const v of result.violations.slice(0, 20)) {
        console.log(
          `    ${colors.red}${v.id}${colors.reset} ${v.frameworkId}/${v.versionLabel}  ${v.sourceUrl}`,
        );
      }
      if (result.violations.length > 20) {
        console.log(
          `    ${colors.dim}... and ${result.violations.length - 20} more${colors.reset}`,
        );
      }
      console.log(
        `\n${colors.dim}  Fix: retry the Wayback push, OR set notes='Wayback push skipped: <reason>'.${colors.reset}`,
      );
    }
  }

  return {
    passed: result.violations.length === 0,
    errors: result.violations.length,
    warnings: 0,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const result = await runCheck({ ci: args.includes("--ci") });
  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("validate-framework-versions crashed:", err);
    process.exit(1);
  });
}
