/**
 * Tests for redundancy.mjs
 *
 * Verifies that computeRedundancy correctly clusters pages by contentFormat
 * before pairwise comparison, and produces equivalent results to the old
 * flat O(n²) approach.
 */

import { describe, it, expect } from 'vitest';
import { computeRedundancy } from '../redundancy.mjs';

// Build a fake page with enough words to pass the `words.size > 10` filter
function makePage(id, text, contentFormat = 'article') {
  return {
    id,
    path: `/docs/${id}`,
    title: id,
    contentFormat,
    rawContent: text,
  };
}

// A block of text with many distinct long words so word-level Jaccard is meaningful
const LOREM =
  'concepts alignment safety interpretability oversight scalable constitutional training robustness corrigible deceptive scheming inner mesa policy reward specification prosaic';

// Repeat a text block to ensure shingles exist (need ≥ SHINGLE_SIZE=5 words per paragraph)
function repeat(text, n) {
  return Array(n).fill(text).join(' ');
}

describe('computeRedundancy', () => {
  it('returns empty results for empty input', () => {
    const { pageRedundancy, pairs } = computeRedundancy([]);
    expect(pairs).toEqual([]);
    expect(pageRedundancy.size).toBe(0);
  });

  it('returns zero redundancy for a single page', () => {
    const pages = [makePage('a', repeat(LOREM, 10))];
    const { pageRedundancy, pairs } = computeRedundancy(pages);
    expect(pairs).toEqual([]);
    expect(pageRedundancy.get('a')?.maxSimilarity).toBe(0);
  });

  it('does NOT compare pages of different contentFormats', () => {
    // Two identical pages but different formats — should not be flagged as similar
    const text = repeat(LOREM, 20);
    const pages = [
      makePage('article-page', text, 'article'),
      makePage('table-page', text, 'table'),
    ];
    const { pageRedundancy, pairs } = computeRedundancy(pages);
    expect(pairs).toHaveLength(0);
    expect(pageRedundancy.get('article-page')?.maxSimilarity).toBe(0);
    expect(pageRedundancy.get('table-page')?.maxSimilarity).toBe(0);
  });

  it('detects highly similar pages of the same contentFormat', () => {
    const text = repeat(LOREM, 20);
    const pages = [
      makePage('page-a', text, 'article'),
      makePage('page-b', text, 'article'),
    ];
    const { pageRedundancy, pairs } = computeRedundancy(pages);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].pageA).toBe('page-a');
    expect(pairs[0].pageB).toBe('page-b');
    expect(pairs[0].similarity).toBeGreaterThan(50);
    expect(pageRedundancy.get('page-a')?.maxSimilarity).toBeGreaterThan(50);
    expect(pageRedundancy.get('page-b')?.maxSimilarity).toBeGreaterThan(50);
  });

  it('only compares within format groups — cross-format identical pages produce no pairs', () => {
    const text = repeat(LOREM, 20);
    const pages = [
      makePage('art1', text, 'article'),
      makePage('art2', text, 'article'),  // same format as art1 → should match
      makePage('tbl1', text, 'table'),    // different format → no match with articles
    ];
    const { pairs } = computeRedundancy(pages);
    // Only art1↔art2 should appear; tbl1 vs art1 and tbl1 vs art2 must not
    expect(pairs).toHaveLength(1);
    const pairIds = pairs.map(p => [p.pageA, p.pageB].sort().join('|'));
    expect(pairIds).toContain('art1|art2');
  });

  it('initialises all pages in pageRedundancy, even those below threshold', () => {
    // 'b' uses completely different vocabulary so similarity < threshold, but both
    // pages pass the words.size > 10 filter and should be in pageRedundancy
    const distinctLongWords =
      'biology chemistry physics mathematics zoology astronomy geology botany neuroscience ecology anthropology psychology';
    const pages = [
      makePage('a', repeat(LOREM, 20)),
      makePage('b', repeat(distinctLongWords, 20)),
    ];
    const { pageRedundancy } = computeRedundancy(pages);
    expect(pageRedundancy.has('a')).toBe(true);
    expect(pageRedundancy.has('b')).toBe(true);
  });

  it('skips very short pages (fewer than 10 distinct long words)', () => {
    const pages = [
      makePage('short', 'hi there'), // filtered out — too few words
      makePage('long', repeat(LOREM, 20)),
    ];
    const { pageRedundancy } = computeRedundancy(pages);
    // 'short' should not appear in pageRedundancy (filtered before initialisation)
    expect(pageRedundancy.has('short')).toBe(false);
    expect(pageRedundancy.has('long')).toBe(true);
  });

  it('limits similarPages to top 5 per page', () => {
    const text = repeat(LOREM, 20);
    // Create 8 nearly-identical pages in the same format
    const pages = Array.from({ length: 8 }, (_, i) =>
      makePage(`page-${i}`, text)
    );
    const { pageRedundancy } = computeRedundancy(pages);
    for (const [, data] of pageRedundancy) {
      expect(data.similarPages.length).toBeLessThanOrEqual(5);
    }
  });

  it('sorts pairs by similarity descending', () => {
    // page-a and page-b are identical; page-c is somewhat similar to both
    const fullText = repeat(LOREM, 20);
    const halfText = LOREM + ' ' + repeat('biology chemistry physics mathematics zoology astronomy', 20);
    const pages = [
      makePage('page-a', fullText),
      makePage('page-b', fullText),
      makePage('page-c', halfText),
    ];
    const { pairs } = computeRedundancy(pages);
    // First pair should have highest similarity
    for (let i = 1; i < pairs.length; i++) {
      expect(pairs[i - 1].similarity).toBeGreaterThanOrEqual(pairs[i].similarity);
    }
  });

  it('computes avgSimilarity for pages with similar matches', () => {
    const text = repeat(LOREM, 20);
    const pages = [
      makePage('a', text),
      makePage('b', text),
    ];
    const { pageRedundancy } = computeRedundancy(pages);
    const dataA = pageRedundancy.get('a');
    expect(dataA?.avgSimilarity).toBeGreaterThan(0);
  });
});
