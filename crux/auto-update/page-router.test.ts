/**
 * Tests for page-router helpers
 *
 * Focus areas:
 * - deduplicatePageUpdates: merges same-pageId entries, takes highest tier
 * - applyBudgetAndPageLimits: enforces page/budget caps, downgrades to polish
 *   instead of skipping when budget is tight (the "budget floor" behaviour)
 */

import { describe, it, expect } from 'vitest';
import { deduplicatePageUpdates, applyBudgetAndPageLimits } from './page-router.ts';
import type { PageUpdate } from './types.ts';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeUpdate(overrides: Partial<PageUpdate> & { pageId: string }): PageUpdate {
  return {
    pageTitle: overrides.pageId,
    reason: 'test reason',
    suggestedTier: 'standard',
    relevantNews: [],
    directions: 'Update the page.',
    ...overrides,
  };
}

// ── deduplicatePageUpdates ───────────────────────────────────────────────────

describe('deduplicatePageUpdates', () => {
  it('returns empty array for empty input', () => {
    expect(deduplicatePageUpdates([])).toHaveLength(0);
  });

  it('returns single update unchanged', () => {
    const updates = [makeUpdate({ pageId: 'llm', suggestedTier: 'standard' })];
    const result = deduplicatePageUpdates(updates);
    expect(result).toHaveLength(1);
    expect(result[0].pageId).toBe('llm');
    expect(result[0].suggestedTier).toBe('standard');
  });

  it('deduplicates duplicate pageIds, keeping first occurrence base', () => {
    const updates = [
      makeUpdate({ pageId: 'llm', suggestedTier: 'polish' }),
      makeUpdate({ pageId: 'llm', suggestedTier: 'polish' }),
    ];
    const result = deduplicatePageUpdates(updates);
    expect(result).toHaveLength(1);
    expect(result[0].pageId).toBe('llm');
  });

  it('takes the higher tier when duplicates differ', () => {
    const updates = [
      makeUpdate({ pageId: 'llm', suggestedTier: 'polish' }),
      makeUpdate({ pageId: 'llm', suggestedTier: 'standard' }),
    ];
    expect(deduplicatePageUpdates(updates)[0].suggestedTier).toBe('standard');

    const updates2 = [
      makeUpdate({ pageId: 'llm', suggestedTier: 'standard' }),
      makeUpdate({ pageId: 'llm', suggestedTier: 'deep' }),
    ];
    expect(deduplicatePageUpdates(updates2)[0].suggestedTier).toBe('deep');

    // Should not downgrade: first entry is higher
    const updates3 = [
      makeUpdate({ pageId: 'llm', suggestedTier: 'deep' }),
      makeUpdate({ pageId: 'llm', suggestedTier: 'polish' }),
    ];
    expect(deduplicatePageUpdates(updates3)[0].suggestedTier).toBe('deep');
  });

  it('merges relevantNews arrays from duplicates', () => {
    const news1 = [{ title: 'Article A', url: 'https://a.com', summary: 'A' }];
    const news2 = [{ title: 'Article B', url: 'https://b.com', summary: 'B' }];
    const updates = [
      makeUpdate({ pageId: 'llm', relevantNews: news1 }),
      makeUpdate({ pageId: 'llm', relevantNews: news2 }),
    ];
    const result = deduplicatePageUpdates(updates);
    expect(result[0].relevantNews).toHaveLength(2);
    expect(result[0].relevantNews.map(n => n.title)).toEqual(['Article A', 'Article B']);
  });

  it('appends directions from duplicate if not already present', () => {
    const updates = [
      makeUpdate({ pageId: 'llm', directions: 'Add section about X.' }),
      makeUpdate({ pageId: 'llm', directions: 'Update timeline.' }),
    ];
    const result = deduplicatePageUpdates(updates);
    expect(result[0].directions).toContain('Add section about X.');
    expect(result[0].directions).toContain('Update timeline.');
  });

  it('does not duplicate directions when they are identical', () => {
    const updates = [
      makeUpdate({ pageId: 'llm', directions: 'Same direction.' }),
      makeUpdate({ pageId: 'llm', directions: 'Same direction.' }),
    ];
    const result = deduplicatePageUpdates(updates);
    expect(result[0].directions).toBe('Same direction.');
  });

  it('does not mutate the relevantNews array of the original first entry', () => {
    const original = makeUpdate({ pageId: 'llm', relevantNews: [{ title: 'A', url: 'u', summary: 's' }] });
    const updates = [original, makeUpdate({ pageId: 'llm', relevantNews: [{ title: 'B', url: 'u2', summary: 's2' }] })];
    deduplicatePageUpdates(updates);
    // original.relevantNews should not be extended because we shallow-copy on first insertion
    expect(original.relevantNews).toHaveLength(1);
  });

  it('preserves first-occurrence order (insertion order)', () => {
    const updates = [
      makeUpdate({ pageId: 'a' }),
      makeUpdate({ pageId: 'b' }),
      makeUpdate({ pageId: 'a' }), // duplicate of a
      makeUpdate({ pageId: 'c' }),
    ];
    const result = deduplicatePageUpdates(updates);
    expect(result.map(r => r.pageId)).toEqual(['a', 'b', 'c']);
  });

  it('preserves non-duplicate entries unchanged', () => {
    const updates = [
      makeUpdate({ pageId: 'page-a', suggestedTier: 'standard' }),
      makeUpdate({ pageId: 'page-b', suggestedTier: 'deep' }),
      makeUpdate({ pageId: 'page-a', suggestedTier: 'polish' }),
    ];
    const result = deduplicatePageUpdates(updates);
    expect(result).toHaveLength(2);
    const ids = result.map(r => r.pageId);
    expect(ids).toContain('page-a');
    expect(ids).toContain('page-b');
  });
});

// ── applyBudgetAndPageLimits ─────────────────────────────────────────────────

describe('applyBudgetAndPageLimits', () => {
  it('returns empty arrays when maxPages is 0', () => {
    const updates = [makeUpdate({ pageId: 'a' })];
    const { finalUpdates, skippedReasons } = applyBudgetAndPageLimits(updates, 0, 100);
    expect(finalUpdates).toHaveLength(0);
    expect(skippedReasons[0].reason).toBe('Exceeded page limit');
  });

  it('returns empty arrays when maxBudget is 0', () => {
    const updates = [makeUpdate({ pageId: 'a', suggestedTier: 'polish' })];
    const { finalUpdates, skippedReasons } = applyBudgetAndPageLimits(updates, 10, 0);
    expect(finalUpdates).toHaveLength(0);
    expect(skippedReasons[0].reason).toBe('Exceeded budget');
  });

  it('returns empty arrays for empty input', () => {
    const { finalUpdates, skippedReasons } = applyBudgetAndPageLimits([], 10, 100);
    expect(finalUpdates).toHaveLength(0);
    expect(skippedReasons).toHaveLength(0);
  });

  it('includes all updates when within budget and page limits', () => {
    const updates = [
      makeUpdate({ pageId: 'a', suggestedTier: 'polish' }),   // $2.50
      makeUpdate({ pageId: 'b', suggestedTier: 'polish' }),   // $2.50
    ];
    const { finalUpdates, skippedReasons } = applyBudgetAndPageLimits(updates, 10, 20);
    expect(finalUpdates).toHaveLength(2);
    expect(skippedReasons).toHaveLength(0);
  });

  it('stops at page limit', () => {
    const updates = [
      makeUpdate({ pageId: 'a' }),
      makeUpdate({ pageId: 'b' }),
      makeUpdate({ pageId: 'c' }),
    ];
    const { finalUpdates, skippedReasons } = applyBudgetAndPageLimits(updates, 2, 100);
    expect(finalUpdates).toHaveLength(2);
    expect(skippedReasons).toHaveLength(1);
    expect(skippedReasons[0].reason).toBe('Exceeded page limit');
  });

  it('skips update that exceeds budget even after polish downgrade', () => {
    const updates = [makeUpdate({ pageId: 'a', suggestedTier: 'standard' })]; // $6.50
    const { finalUpdates, skippedReasons } = applyBudgetAndPageLimits(updates, 10, 1); // only $1
    expect(finalUpdates).toHaveLength(0);
    expect(skippedReasons[0].reason).toBe('Exceeded budget');
  });

  it('downgrades standard to polish when budget is tight', () => {
    // Budget: $5 — standard costs $6.50 but polish costs $2.50
    const updates = [makeUpdate({ pageId: 'a', suggestedTier: 'standard' })];
    const { finalUpdates, skippedReasons } = applyBudgetAndPageLimits(updates, 10, 5);
    expect(finalUpdates).toHaveLength(1);
    expect(finalUpdates[0].suggestedTier).toBe('polish');
    expect(skippedReasons).toHaveLength(0);
  });

  it('does not mutate input objects when downgrading tier', () => {
    const original = makeUpdate({ pageId: 'a', suggestedTier: 'standard' });
    applyBudgetAndPageLimits([original], 10, 5);
    // The original object's tier must remain 'standard'
    expect(original.suggestedTier).toBe('standard');
  });

  it('downgrades deep to polish when budget is tight', () => {
    // Budget: $4 — deep costs $12.50, standard costs $6.50, polish costs $2.50
    const updates = [makeUpdate({ pageId: 'a', suggestedTier: 'deep' })];
    const { finalUpdates } = applyBudgetAndPageLimits(updates, 10, 4);
    expect(finalUpdates).toHaveLength(1);
    expect(finalUpdates[0].suggestedTier).toBe('polish');
  });

  it('does not downgrade polish further — skips when polish itself exceeds budget', () => {
    // Budget: $2 — polish costs $2.50
    const updates = [makeUpdate({ pageId: 'a', suggestedTier: 'polish' })];
    const { finalUpdates, skippedReasons } = applyBudgetAndPageLimits(updates, 10, 2);
    expect(finalUpdates).toHaveLength(0);
    expect(skippedReasons[0].reason).toBe('Exceeded budget');
  });

  it('uses polish budget after downgrade so subsequent items can still fit', () => {
    // Budget: $5 — first item standard ($6.50 → downgraded to polish $2.50),
    // leaving $2.50 for second item (polish $2.50).
    const updates = [
      makeUpdate({ pageId: 'a', suggestedTier: 'standard' }),
      makeUpdate({ pageId: 'b', suggestedTier: 'polish' }),
    ];
    const { finalUpdates } = applyBudgetAndPageLimits(updates, 10, 5);
    expect(finalUpdates).toHaveLength(2);
    expect(finalUpdates[0].suggestedTier).toBe('polish');
    expect(finalUpdates[1].suggestedTier).toBe('polish');
  });

  it('tracks budget correctly across multiple included pages', () => {
    const updates = [
      makeUpdate({ pageId: 'a', suggestedTier: 'standard' }), // $6.50
      makeUpdate({ pageId: 'b', suggestedTier: 'standard' }), // $6.50 — budget exhausted
      makeUpdate({ pageId: 'c', suggestedTier: 'polish' }),   // $2.50 — downgrade not possible (polish > remaining 0)
    ];
    const { finalUpdates, skippedReasons } = applyBudgetAndPageLimits(updates, 10, 13);
    // a: $6.50, remaining $6.50; b: $6.50, remaining $0; c: polish $2.50 > $0 → skip
    expect(finalUpdates).toHaveLength(2);
    expect(skippedReasons).toHaveLength(1);
    expect(skippedReasons[0].item).toBe('c');
  });
});
