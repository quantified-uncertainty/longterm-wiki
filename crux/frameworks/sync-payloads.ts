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
    id: generateId(
      `framework-threshold:${versionId}:${t.riskDomainCanonical}:${t.tierSortOrder}`,
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
    items: aggregate.items.map((item: DiffItem, idx: number) => ({
      id: generateId(
        `framework-diff-item:${diffId}:${idx}:${item.changeType}:${item.riskDomainCanonical ?? 'none'}`,
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
    })),
  };
}
