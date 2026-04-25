import { describe, it, expect } from 'vitest';
import {
  structuralDiff,
  aggregateDiff,
  type DiffItem,
} from './diff.ts';
import type { ExtractedThreshold } from './extract.ts';
import type { CanonicalDomain } from './risk-domains.ts';

function threshold(
  overrides: Partial<ExtractedThreshold> & {
    riskDomainCanonical: CanonicalDomain;
    tierSortOrder: number;
  },
): ExtractedThreshold {
  return {
    riskDomainCanonical: overrides.riskDomainCanonical,
    riskDomainLabel: overrides.riskDomainLabel ?? overrides.riskDomainCanonical,
    tierLabel: overrides.tierLabel ?? 'T1',
    tierSortOrder: overrides.tierSortOrder,
    triggerDescription: overrides.triggerDescription ?? 'trigger',
    sourceQuote: overrides.sourceQuote ?? 'quote',
    sourcePageHint: overrides.sourcePageHint ?? null,
    requiredMitigations: overrides.requiredMitigations ?? null,
    associatedEvals: overrides.associatedEvals ?? null,
    commitmentLanguage: overrides.commitmentLanguage ?? null,
    extractionConfidence: overrides.extractionConfidence ?? 1.0,
  };
}

describe('structuralDiff', () => {
  it('returns no items when both sides are identical', () => {
    const before = [threshold({ riskDomainCanonical: 'cbrn', tierSortOrder: 3 })];
    const after = [threshold({ riskDomainCanonical: 'cbrn', tierSortOrder: 3 })];
    expect(structuralDiff(before, after)).toEqual([]);
  });

  it('flags additions', () => {
    const before: ExtractedThreshold[] = [];
    const after = [threshold({ riskDomainCanonical: 'cbrn', tierSortOrder: 3 })];
    const items = structuralDiff(before, after);
    expect(items.length).toBe(1);
    expect(items[0].changeType).toBe('threshold_added');
    expect(items[0].beforeSnapshot).toBeNull();
    expect(items[0].afterSnapshot?.riskDomainCanonical).toBe('cbrn');
  });

  it('flags removals', () => {
    const before = [threshold({ riskDomainCanonical: 'cbrn', tierSortOrder: 3 })];
    const after: ExtractedThreshold[] = [];
    const items = structuralDiff(before, after);
    expect(items.length).toBe(1);
    expect(items[0].changeType).toBe('threshold_removed');
    expect(items[0].afterSnapshot).toBeNull();
  });

  it('flags commitment-language weakening', () => {
    const before = [
      threshold({
        riskDomainCanonical: 'cbrn',
        tierSortOrder: 3,
        commitmentLanguage: 'committed',
      }),
    ];
    const after = [
      threshold({
        riskDomainCanonical: 'cbrn',
        tierSortOrder: 3,
        commitmentLanguage: 'aspirational',
      }),
    ];
    const items = structuralDiff(before, after);
    expect(items.length).toBe(1);
    expect(items[0].changeType).toBe('commitment_weakened');
  });

  it('flags commitment-language strengthening', () => {
    const before = [
      threshold({
        riskDomainCanonical: 'cbrn',
        tierSortOrder: 3,
        commitmentLanguage: 'aspirational',
      }),
    ];
    const after = [
      threshold({
        riskDomainCanonical: 'cbrn',
        tierSortOrder: 3,
        commitmentLanguage: 'committed',
      }),
    ];
    const items = structuralDiff(before, after);
    expect(items[0].changeType).toBe('commitment_strengthened');
  });

  it('flags eval changes', () => {
    const before = [
      threshold({
        riskDomainCanonical: 'cbrn',
        tierSortOrder: 3,
        associatedEvals: { eval_names: ['A'] },
      }),
    ];
    const after = [
      threshold({
        riskDomainCanonical: 'cbrn',
        tierSortOrder: 3,
        associatedEvals: { eval_names: ['A', 'B'] },
      }),
    ];
    const items = structuralDiff(before, after);
    expect(items[0].changeType).toBe('eval_changed');
  });

  it('treats trigger-description changes as non-identical', () => {
    const before = [
      threshold({
        riskDomainCanonical: 'cbrn',
        tierSortOrder: 3,
        triggerDescription: 'original',
      }),
    ];
    const after = [
      threshold({
        riskDomainCanonical: 'cbrn',
        tierSortOrder: 3,
        triggerDescription: 'rewritten but same substance',
      }),
    ];
    const items = structuralDiff(before, after);
    expect(items.length).toBe(1);
  });
});

describe('aggregateDiff', () => {
  function diffItem(
    classifierTag: DiffItem['classifierTag'],
    changeType: DiffItem['changeType'] = 'clarification',
  ): DiffItem {
    return {
      changeType,
      riskDomainCanonical: 'cbrn',
      beforeSnapshot: null,
      afterSnapshot: null,
      classifierTag,
      rationale: 'test rationale',
      severity: 1,
    };
  }

  it('flags weakening when any item is tagged weaker', () => {
    const agg = aggregateDiff([diffItem('weaker'), diffItem('clarification')]);
    expect(agg.weakeningFlagged).toBe(true);
    expect(agg.strengtheningFlagged).toBe(false);
    expect(agg.overallDirection).toBe('weaker');
  });

  it('flags both when weaker and stronger are present', () => {
    const agg = aggregateDiff([diffItem('weaker'), diffItem('stronger')]);
    expect(agg.weakeningFlagged).toBe(true);
    expect(agg.strengtheningFlagged).toBe(true);
    expect(agg.overallDirection).toBe('mixed');
  });

  it('treats scope_narrowed as weaker', () => {
    const agg = aggregateDiff([diffItem('scope_narrowed')]);
    expect(agg.weakeningFlagged).toBe(true);
  });

  it('treats scope_broadened as stronger', () => {
    const agg = aggregateDiff([diffItem('scope_broadened')]);
    expect(agg.strengtheningFlagged).toBe(true);
  });

  it('treats clarifications + rewrites as neutral', () => {
    const agg = aggregateDiff([
      diffItem('clarification'),
      diffItem('rewrite_equivalent'),
    ]);
    expect(agg.weakeningFlagged).toBe(false);
    expect(agg.strengtheningFlagged).toBe(false);
    expect(agg.neutralChangesCount).toBe(2);
  });

  it('classifies an empty list as neutral', () => {
    const agg = aggregateDiff([]);
    expect(agg.overallDirection).toBe('neutral');
    expect(agg.weakeningFlagged).toBe(false);
    expect(agg.strengtheningFlagged).toBe(false);
  });

  it('classifies a large all-neutral diff as rewrite', () => {
    const items = Array.from({ length: 11 }, () => diffItem('clarification'));
    const agg = aggregateDiff(items);
    expect(agg.overallDirection).toBe('rewrite');
  });

  it('never emits a review verdict on its own — change summary marks it unreviewed', () => {
    const agg = aggregateDiff([diffItem('weaker')]);
    expect(agg.changeSummary).toContain('unreviewed');
  });
});
