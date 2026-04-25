/**
 * Pure mappers from extractor / diff outputs into wiki-server sync payloads
 * (QUA-691 Phase 4).
 *
 * Lives in `crux/frameworks/` so both the CLI (`crux/commands/frameworks.ts`)
 * and the orchestrator (`crux/frameworks/orchestrator.ts`) can share them
 * without a circular import.
 */

import { generateId } from '../lib/grant-import/id.ts';
import type { ExtractedThreshold } from './extract.ts';
import type { DiffAggregate, DiffItem } from './diff.ts';

/**
 * Build sync-item payloads for `/api/framework-capability-thresholds/sync`
 * from an extract result. Each row gets a deterministic `id` so re-runs
 * upsert cleanly.
 */
export function toThresholdSyncItems(
  versionId: string,
  thresholds: ExtractedThreshold[],
  meta: { extractionModel: string },
): Array<Record<string, unknown>> {
  return thresholds.map((t) => ({
    // Mix tierLabel into the seed so two thresholds within the same
    // (riskDomain, tierSortOrder) — e.g. an LLM that extracted two distinct
    // triggers in the same domain/tier — get distinct stable ids. The schema
    // has no unique constraint on (versionId, riskDomain, tierSortOrder), so
    // collapsing them silently overwrites the first row in upsert.
    id: generateId(
      `framework-threshold:${versionId}:${t.riskDomainCanonical}:${t.tierSortOrder}:${t.tierLabel}`,
    ),
    versionId,
    riskDomainCanonical: t.riskDomainCanonical,
    riskDomainLabel: t.riskDomainLabel,
    tierLabel: t.tierLabel,
    tierSortOrder: t.tierSortOrder,
    triggerDescription: t.triggerDescription,
    sourceQuote: t.sourceQuote,
    sourcePageHint: t.sourcePageHint,
    requiredMitigations: t.requiredMitigations,
    associatedEvals: t.associatedEvals,
    commitmentLanguage: t.commitmentLanguage,
    extractedByModel: meta.extractionModel,
    extractionConfidence: t.extractionConfidence,
    humanReviewed: false,
    humanReviewNotes: null,
  }));
}

/**
 * Build the `framework_diffs` + `framework_diff_items` sync payloads.
 */
export function toDiffSyncPayloads(
  fromVersionId: string,
  toVersionId: string,
  aggregate: DiffAggregate,
  meta: { classifiedByModel: string | null },
): {
  diff: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
} {
  const diffId = generateId(`framework-diff:${fromVersionId}:${toVersionId}`);
  return {
    diff: {
      id: diffId,
      fromVersionId,
      toVersionId,
      changeSummary: aggregate.changeSummary,
      weakeningFlagged: aggregate.weakeningFlagged,
      strengtheningFlagged: aggregate.strengtheningFlagged,
      neutralChangesCount: aggregate.neutralChangesCount,
      diffDetails: { itemCount: aggregate.items.length },
      overallDirection: aggregate.overallDirection,
      humanReviewed: false,
      reviewVerdict: 'unreviewed',
      reviewNotes: null,
      classifiedByModel: meta.classifiedByModel,
    },
    items: aggregate.items.map((item: DiffItem) => {
      // Discriminator must be stable across diff sorts — using array index
      // would churn the entire row set whenever structuralDiff happened to
      // reorder same-domain items, orphaning the previous N and inserting N
      // new ones with identical content. Prefer the snapshots' tierLabel
      // (always present on at least one of beforeSnapshot/afterSnapshot for
      // every changeType in the diff pipeline), with classifierTag as a
      // tiebreaker for the rare case of two same-tier changes.
      const tierKey =
        item.beforeSnapshot?.tierLabel ?? item.afterSnapshot?.tierLabel ?? 'unknown';
      const tagKey = item.classifierTag ?? 'unclassified';
      return {
      id: generateId(
        `framework-diff-item:${diffId}:${tierKey}:${tagKey}:${item.changeType}:${item.riskDomainCanonical ?? 'none'}`,
      ),
      diffId,
      changeType: item.changeType,
      riskDomainCanonical: item.riskDomainCanonical,
      beforeSnapshot: item.beforeSnapshot
        ? (item.beforeSnapshot as unknown as Record<string, unknown>)
        : null,
      afterSnapshot: item.afterSnapshot
        ? (item.afterSnapshot as unknown as Record<string, unknown>)
        : null,
      severity: item.severity,
      classifierTag: item.classifierTag,
      rationale: item.rationale,
      };
    }),
  };
}
