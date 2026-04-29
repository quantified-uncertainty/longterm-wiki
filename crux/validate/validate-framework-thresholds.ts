#!/usr/bin/env node

/**
 * Frontier safety framework — capability threshold integrity (QUA-711 / QUA-706 Phase 4-D).
 *
 * For every `framework_capability_thresholds` row whose parent
 * `safety_framework_versions.ingest_status = 'published'`, the
 * `source_quote` must have round-tripped against the source via
 * `verifyExcerpt()` at extraction time, OR carry an explicit
 * `human_review_notes` value documenting why the span-verify miss is
 * acceptable.
 *
 * The actual `verifyExcerpt()` call happens inside the two-pass extractor
 * (`crux/frameworks/extract.ts`) and its result is persisted as the
 * `extraction_confidence` numeric. A confidence ≥ 0.7 means
 * `verifyExcerpt(sourceQuote, sourceText).verified` was true. Lower
 * (or NULL) means the round-trip failed; in that case the row is only
 * acceptable if a human reviewed it and recorded a reason.
 *
 * Network dependency: skips silently when wiki-server is unreachable
 * (advisory tier semantics — we'd rather miss a check than fail PRs
 * offline).
 *
 * Usage:
 *   npx tsx crux/validate/validate-framework-thresholds.ts
 *   npx tsx crux/validate/validate-framework-thresholds.ts --ci
 *
 * Exit codes:
 *   0 = All checks pass (or server unreachable, or no published data yet)
 *   1 = Invariant violation found
 */

import { fileURLToPath } from "url";
import { getColors } from "../lib/output.ts";
import { apiRequest, type ApiResult } from "../lib/wiki-server/client.ts";
import type { ValidatorResult, ValidatorOptions } from "./types.ts";

/** Confidence floor: extractor's `verifyExcerpt()` returns ≥ 0.7 on a verified excerpt. */
const VERIFIED_CONFIDENCE_FLOOR = 0.7;

interface ThresholdRow {
  id: string;
  versionId: string;
  riskDomainCanonical: string;
  tierLabel: string;
  sourceQuote: string;
  extractionConfidence: number | null;
  humanReviewed: boolean;
  humanReviewNotes: string | null;
}

interface VersionRow {
  id: string;
  frameworkId: string;
  versionLabel: string;
  ingestStatus: string;
}

interface ThresholdsResponse {
  items: ThresholdRow[];
  total: number;
  limit: number;
  offset: number;
}

interface VersionsResponse {
  items: VersionRow[];
  total: number;
  limit: number;
  offset: number;
}

async function fetchAllThresholds(): Promise<ApiResult<ThresholdRow[]>> {
  const PAGE_SIZE = 500;
  const MAX_PAGES = 50;
  const all: ThresholdRow[] = [];
  let offset = 0;
  let total = Infinity;

  for (let i = 0; i < MAX_PAGES && offset < total; i++) {
    const result = await apiRequest<ThresholdsResponse>(
      "GET",
      `/api/framework-capability-thresholds/all?limit=${PAGE_SIZE}&offset=${offset}`,
    );
    if (!result.ok) return result;
    all.push(...result.data.items);
    total = result.data.total;
    offset += result.data.limit ?? PAGE_SIZE;
  }
  return { ok: true, data: all };
}

async function fetchAllVersions(): Promise<ApiResult<VersionRow[]>> {
  const PAGE_SIZE = 500;
  const MAX_PAGES = 20;
  const all: VersionRow[] = [];
  let offset = 0;
  let total = Infinity;

  for (let i = 0; i < MAX_PAGES && offset < total; i++) {
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
  versionLabel: string;
  riskDomainCanonical: string;
  tierLabel: string;
  reason: "low-confidence-no-notes" | "missing-source-quote";
  extractionConfidence: number | null;
}

interface CheckResult {
  serverAvailable: boolean;
  publishedVersionCount: number;
  thresholdCount: number;
  publishedThresholdCount: number;
  violations: Violation[];
}

export function detectViolations(
  thresholds: ThresholdRow[],
  versions: VersionRow[],
): { publishedThresholdCount: number; violations: Violation[] } {
  const publishedVersionIds = new Set(
    versions.filter((v) => v.ingestStatus === "published").map((v) => v.id),
  );
  const versionLabelById = new Map(versions.map((v) => [v.id, v.versionLabel]));

  const violations: Violation[] = [];
  let publishedThresholdCount = 0;

  for (const t of thresholds) {
    if (!publishedVersionIds.has(t.versionId)) continue;
    publishedThresholdCount++;

    const sourceQuote = t.sourceQuote ?? "";
    if (sourceQuote.trim().length === 0) {
      violations.push({
        id: t.id,
        versionLabel: versionLabelById.get(t.versionId) ?? t.versionId,
        riskDomainCanonical: t.riskDomainCanonical,
        tierLabel: t.tierLabel,
        reason: "missing-source-quote",
        extractionConfidence: t.extractionConfidence,
      });
      continue;
    }

    const conf = t.extractionConfidence;
    const verified = typeof conf === "number" && conf >= VERIFIED_CONFIDENCE_FLOOR;
    const humanOverride =
      t.humanReviewed && (t.humanReviewNotes ?? "").trim().length > 0;

    if (!verified && !humanOverride) {
      violations.push({
        id: t.id,
        versionLabel: versionLabelById.get(t.versionId) ?? t.versionId,
        riskDomainCanonical: t.riskDomainCanonical,
        tierLabel: t.tierLabel,
        reason: "low-confidence-no-notes",
        extractionConfidence: conf,
      });
    }
  }

  return { publishedThresholdCount, violations };
}

async function detect(): Promise<CheckResult> {
  const versionsResult = await fetchAllVersions();
  if (!versionsResult.ok) {
    return {
      serverAvailable: false,
      publishedVersionCount: 0,
      thresholdCount: 0,
      publishedThresholdCount: 0,
      violations: [],
    };
  }

  const thresholdsResult = await fetchAllThresholds();
  if (!thresholdsResult.ok) {
    return {
      serverAvailable: false,
      publishedVersionCount: 0,
      thresholdCount: 0,
      publishedThresholdCount: 0,
      violations: [],
    };
  }

  const versions = versionsResult.data;
  const thresholds = thresholdsResult.data;

  const publishedVersionCount = versions.filter(
    (v) => v.ingestStatus === "published",
  ).length;

  const { publishedThresholdCount, violations } = detectViolations(
    thresholds,
    versions,
  );

  return {
    serverAvailable: true,
    publishedVersionCount,
    thresholdCount: thresholds.length,
    publishedThresholdCount,
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
        `\n${colors.dim}  Wiki-server unreachable — skipping framework threshold checks${colors.reset}`,
      );
    }
    return { passed: true, errors: 0, warnings: 0 };
  }

  if (ciMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `\n  Versions: ${result.publishedVersionCount} published  ·  Thresholds: ${result.publishedThresholdCount} published / ${result.thresholdCount} total`,
    );

    if (result.violations.length === 0) {
      console.log(
        `${colors.green}  ✓ Every published threshold has either verified source_quote (confidence ≥ ${VERIFIED_CONFIDENCE_FLOOR}) or human_review_notes${colors.reset}`,
      );
    } else {
      console.log(
        `${colors.red}  ✗ ${result.violations.length} published threshold(s) lack source_quote verification:${colors.reset}`,
      );
      for (const v of result.violations.slice(0, 20)) {
        const conf = v.extractionConfidence == null ? "null" : v.extractionConfidence.toFixed(2);
        console.log(
          `    ${colors.red}${v.id}${colors.reset} ${v.versionLabel}/${v.riskDomainCanonical}/${v.tierLabel} reason=${v.reason} conf=${conf}`,
        );
      }
      if (result.violations.length > 20) {
        console.log(
          `    ${colors.dim}... and ${result.violations.length - 20} more${colors.reset}`,
        );
      }
      console.log(
        `\n${colors.dim}  Fix: re-run extractor (raises extraction_confidence) OR mark human_reviewed=true with a non-empty human_review_notes.${colors.reset}`,
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
    console.error("validate-framework-thresholds crashed:", err);
    process.exit(1);
  });
}
