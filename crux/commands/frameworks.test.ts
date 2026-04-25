import { describe, it, expect } from 'vitest';
import { toThresholdSyncItems, toDiffSyncPayloads } from './frameworks.ts';
import type { ExtractedThreshold } from '../frameworks/extract.ts';
import { aggregateDiff, type DiffItem } from '../frameworks/diff.ts';

function threshold(overrides: Partial<ExtractedThreshold> = {}): ExtractedThreshold {
  return {
    riskDomainCanonical: 'cbrn',
    riskDomainLabel: 'CBRN',
    tierLabel: 'ASL-3',
    tierSortOrder: 3,
    triggerDescription: 'A trigger',
    sourceQuote: 'A source quote',
    sourcePageHint: null,
    requiredMitigations: null,
    associatedEvals: null,
    commitmentLanguage: 'committed',
    extractionConfidence: 0.9,
    ...overrides,
  };
}

describe('toThresholdSyncItems', () => {
  it('builds one sync item per threshold with deterministic id', () => {
    const items = toThresholdSyncItems('v1', [
      threshold({ tierSortOrder: 2 }),
      threshold({ riskDomainCanonical: 'cyber', tierSortOrder: 3 }),
    ], { extractionModel: 'claude-sonnet-4-6' });
    expect(items.length).toBe(2);
    expect(items[0].id).toBeDefined();
    expect(items[0].versionId).toBe('v1');
    expect(items[0].extractedByModel).toBe('claude-sonnet-4-6');
    expect(items[0].humanReviewed).toBe(false);
  });

  it('deterministic ids: same inputs produce the same id', () => {
    const t = threshold();
    const a = toThresholdSyncItems('v1', [t], { extractionModel: 'x' });
    const b = toThresholdSyncItems('v1', [t], { extractionModel: 'x' });
    expect(a[0].id).toBe(b[0].id);
  });

  it('deterministic ids: different versionId produces a different id', () => {
    const t = threshold();
    const a = toThresholdSyncItems('v1', [t], { extractionModel: 'x' });
    const b = toThresholdSyncItems('v2', [t], { extractionModel: 'x' });
    expect(a[0].id).not.toBe(b[0].id);
  });

  it('returns empty list for empty input', () => {
    expect(toThresholdSyncItems('v1', [], { extractionModel: 'x' })).toEqual([]);
  });
});

describe('toDiffSyncPayloads', () => {
  function diffItem(tag: DiffItem['classifierTag']): DiffItem {
    return {
      changeType: 'mitigation_softened',
      riskDomainCanonical: 'cbrn',
      beforeSnapshot: null,
      afterSnapshot: null,
      classifierTag: tag,
      rationale: 'because',
      severity: 2,
    };
  }

  it('always lands with reviewVerdict=unreviewed, never pre-judged', () => {
    const agg = aggregateDiff([diffItem('weaker')]);
    const payload = toDiffSyncPayloads('vA', 'vB', agg, { classifiedByModel: 'sonnet' });
    expect(payload.diff.reviewVerdict).toBe('unreviewed');
    expect(payload.diff.humanReviewed).toBe(false);
    expect(payload.diff.weakeningFlagged).toBe(true);
    expect(payload.diff.classifiedByModel).toBe('sonnet');
  });

  it('produces one diff item payload per item', () => {
    const agg = aggregateDiff([
      diffItem('weaker'),
      diffItem('stronger'),
      diffItem('clarification'),
    ]);
    const payload = toDiffSyncPayloads('vA', 'vB', agg, { classifiedByModel: null });
    expect(payload.items.length).toBe(3);
    // Every item refers back to the diff row.
    for (const item of payload.items) {
      expect(item.diffId).toBe(payload.diff.id);
    }
  });

  it('empty diff produces an items array of length 0', () => {
    const agg = aggregateDiff([]);
    const payload = toDiffSyncPayloads('vA', 'vB', agg, { classifiedByModel: null });
    expect(payload.items.length).toBe(0);
  });

  it('id is deterministic for the same version pair', () => {
    const agg = aggregateDiff([]);
    const a = toDiffSyncPayloads('vA', 'vB', agg, { classifiedByModel: null });
    const b = toDiffSyncPayloads('vA', 'vB', agg, { classifiedByModel: null });
    expect(a.diff.id).toBe(b.diff.id);
  });
});
