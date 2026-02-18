/**
 * Tests for the sorted-scan name-prefix matching algorithm used in
 * computeRelatedGraph (build-data.mjs).
 *
 * The algorithm finds all pairs of entity IDs where one ID is a prefix of the
 * other (connected by a '-'). For example: "anthropic" ↔ "anthropic-ipo".
 *
 * We extract the logic into a pure helper here to verify it matches the
 * behaviour of the original O(n²) approach.
 */

import { describe, it, expect } from 'vitest';

/**
 * Original O(n²) implementation (reference).
 * Returns a set of canonical pair strings "a|b" (a < b lexicographically).
 */
function findPrefixPairsNaive(ids) {
  const pairs = new Set();
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i], b = ids[j];
      if (b.startsWith(a + '-') || a.startsWith(b + '-')) {
        pairs.add([a, b].sort().join('|'));
      }
    }
  }
  return pairs;
}

/**
 * Optimised O(n log n) implementation (mirrors build-data.mjs).
 */
function findPrefixPairsOptimised(ids) {
  const pairs = new Set();
  const sorted = [...ids].sort();
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const prefix = a + '-';
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      if (b.startsWith(prefix)) {
        pairs.add([a, b].sort().join('|'));
      } else {
        break;
      }
    }
  }
  return pairs;
}

/** Asserts both implementations agree on a given list of IDs. */
function assertEquivalent(ids) {
  const naive = findPrefixPairsNaive(ids);
  const fast = findPrefixPairsOptimised(ids);
  expect([...fast].sort()).toEqual([...naive].sort());
}

describe('name-prefix matching (sorted-scan vs. naive)', () => {
  it('produces no pairs for an empty list', () => {
    assertEquivalent([]);
    expect(findPrefixPairsOptimised([])).toEqual(new Set());
  });

  it('produces no pairs for a single ID', () => {
    assertEquivalent(['anthropic']);
    expect(findPrefixPairsOptimised(['anthropic'])).toEqual(new Set());
  });

  it('detects a simple prefix pair', () => {
    const ids = ['anthropic', 'anthropic-ipo'];
    assertEquivalent(ids);
    const result = findPrefixPairsOptimised(ids);
    expect(result.has('anthropic|anthropic-ipo')).toBe(true);
    expect(result.size).toBe(1);
  });

  it('works regardless of original array order', () => {
    // Reversed input should give the same result
    assertEquivalent(['anthropic-ipo', 'anthropic']);
    const result = findPrefixPairsOptimised(['anthropic-ipo', 'anthropic']);
    expect(result.has('anthropic|anthropic-ipo')).toBe(true);
  });

  it('handles multiple levels of nesting (a ↔ a-b ↔ a-b-c)', () => {
    const ids = ['org', 'org-division', 'org-division-team'];
    assertEquivalent(ids);
    const result = findPrefixPairsOptimised(ids);
    // org ↔ org-division
    expect(result.has('org|org-division')).toBe(true);
    // org ↔ org-division-team (startsWith "org-")
    expect(result.has('org|org-division-team')).toBe(true);
    // org-division ↔ org-division-team
    expect(result.has('org-division|org-division-team')).toBe(true);
  });

  it('does NOT match IDs sharing a prefix without a dash separator', () => {
    // "abc" and "abcd" should NOT match — they don't share a dash-separated prefix
    const ids = ['abc', 'abcd'];
    assertEquivalent(ids);
    const result = findPrefixPairsOptimised(ids);
    expect(result.size).toBe(0);
  });

  it('handles mixed matches and non-matches correctly', () => {
    const ids = [
      'anthropic',
      'anthropic-ipo',
      'openai',
      'openai-spinoff',
      'deepmind',          // no related IDs
      'openai-spinoff-uk', // nested under openai-spinoff
    ];
    assertEquivalent(ids);
    const result = findPrefixPairsOptimised(ids);
    expect(result.has('anthropic|anthropic-ipo')).toBe(true);
    expect(result.has('openai|openai-spinoff')).toBe(true);
    expect(result.has('openai|openai-spinoff-uk')).toBe(true);
    expect(result.has('openai-spinoff|openai-spinoff-uk')).toBe(true);
    // deepmind should appear in no pairs
    expect([...result].some(p => p.includes('deepmind'))).toBe(false);
  });

  it('handles a large list without producing wrong results', () => {
    // Mix of related and unrelated IDs drawn from plausible entity slugs
    const ids = [
      'anthropic', 'anthropic-ceo', 'anthropic-ipo', 'anthropic-safety-team',
      'openai', 'openai-board',
      'compute', 'compute-governance',
      'alignment', 'alignment-tax',
      'deepmind',
      'miri',
    ];
    assertEquivalent(ids);
  });

  it('break optimisation: does not skip matches that follow a non-match in sorted order', () => {
    // This tests the assumption that '-' (ASCII 45) sorts before all letters.
    // "abc-def" must appear before "abca" in sorted order.
    const ids = ['abc', 'abca', 'abc-def'];
    // Sorted: ["abc", "abc-def", "abca"]
    // When scanning from "abc": j=1 → "abc-def" matches; j=2 → "abca" doesn't → break
    assertEquivalent(ids);
    const result = findPrefixPairsOptimised(ids);
    expect(result.has('abc|abc-def')).toBe(true);
    expect(result.has('abc|abca')).toBe(false);
    expect(result.has('abc-def|abca')).toBe(false);
  });

  it('does not match IDs that are equal', () => {
    // Duplicate IDs shouldn't appear in entity lists, but guard against it
    const ids = ['foo', 'foo', 'foo-bar'];
    // Naive would find foo|foo-bar twice; optimised finds it at least once
    const result = findPrefixPairsOptimised(ids);
    expect(result.has('foo|foo-bar')).toBe(true);
  });
});
