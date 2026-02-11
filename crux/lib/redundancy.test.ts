/**
 * Unit Tests for redundancy.ts algorithmic functions
 */

import { describe, it, expect } from 'vitest';
import { computeRedundancy, getRedundancyScore, getSimilarPages, type PageInput } from './redundancy.ts';

describe('computeRedundancy', () => {
  it('returns empty result for no pages', () => {
    const result = computeRedundancy([]);
    expect(result.pairs.length).toBe(0);
    expect(result.pageRedundancy.size).toBe(0);
  });

  it('returns empty result for single page', () => {
    const pages: PageInput[] = [{
      id: 'page-1',
      path: '/page-1',
      title: 'Page 1',
      rawContent: 'This is some content about artificial intelligence safety and alignment research. It covers many important topics in detail with sufficient words for analysis.',
    }];
    const result = computeRedundancy(pages);
    expect(result.pairs.length).toBe(0);
  });

  it('detects high similarity between near-duplicate pages', () => {
    const sharedContent = 'Artificial intelligence safety research focuses on ensuring that advanced AI systems are aligned with human values and intentions. This field examines potential risks from powerful AI systems including deceptive alignment and power seeking behavior. Researchers study various approaches to AI alignment including RLHF constitutional AI and interpretability techniques.';
    const pages: PageInput[] = [
      {
        id: 'page-a',
        path: '/page-a',
        title: 'Page A',
        rawContent: `---\ntitle: Page A\n---\n${sharedContent}`,
      },
      {
        id: 'page-b',
        path: '/page-b',
        title: 'Page B',
        rawContent: `---\ntitle: Page B\n---\n${sharedContent} Additional unique content here to make it slightly different.`,
      },
    ];
    const result = computeRedundancy(pages);
    expect(result.pairs.length).toBeGreaterThan(0);
    expect(result.pairs[0].similarity).toBeGreaterThan(20);
  });

  it('does not flag dissimilar pages', () => {
    const pages: PageInput[] = [
      {
        id: 'page-x',
        path: '/page-x',
        title: 'Page X',
        rawContent: 'Quantum computing uses principles of quantum mechanics including superposition and entanglement to perform calculations that would be intractable for classical computers. Major players include IBM Google and Rigetti computing. The field has seen rapid progress in recent years.',
      },
      {
        id: 'page-y',
        path: '/page-y',
        title: 'Page Y',
        rawContent: 'Climate change refers to long term shifts in temperatures and weather patterns. Human activities have been the main driver since the industrial revolution primarily through burning fossil fuels. The Paris Agreement aims to limit global warming to below two degrees Celsius.',
      },
    ];
    const result = computeRedundancy(pages);
    // With very different content, similarity should be low or no pairs found
    const highSimilarityPairs = result.pairs.filter(p => p.similarity > 30);
    expect(highSimilarityPairs.length).toBe(0);
  });

  it('skips pages with very short content', () => {
    const pages: PageInput[] = [
      { id: 'short', path: '/short', title: 'Short', rawContent: 'Just a few words.' },
      { id: 'long', path: '/long', title: 'Long', rawContent: 'This is a much longer page with plenty of content about artificial intelligence safety and alignment research covering many different topics with sufficient words for proper analysis and comparison.' },
    ];
    const result = computeRedundancy(pages);
    expect(result.pairs.length).toBe(0);
  });

  it('limits similar pages to top 5', () => {
    // Create 8 pages with shared content to generate many pairs
    const baseContent = 'Machine learning models are trained on large datasets using gradient descent optimization. Neural networks consist of multiple layers of interconnected nodes that process information through forward and backward propagation.';
    const pages: PageInput[] = Array.from({ length: 8 }, (_, i) => ({
      id: `page-${i}`,
      path: `/page-${i}`,
      title: `Page ${i}`,
      rawContent: `${baseContent} Additional content for page ${i} with some variation and unique material about topic ${i} covering additional points.`,
    }));
    const result = computeRedundancy(pages);
    for (const [, data] of result.pageRedundancy) {
      expect(data.similarPages.length).toBeLessThanOrEqual(5);
    }
  });
});

describe('getRedundancyScore', () => {
  it('returns 0 for unknown page', () => {
    const map = new Map();
    expect(getRedundancyScore('unknown', map)).toBe(0);
  });

  it('returns maxSimilarity for known page', () => {
    const map = new Map([['page-1', { maxSimilarity: 42, avgSimilarity: 30, similarPages: [] }]]);
    expect(getRedundancyScore('page-1', map)).toBe(42);
  });
});

describe('getSimilarPages', () => {
  it('returns empty array for unknown page', () => {
    const map = new Map();
    expect(getSimilarPages('unknown', map)).toEqual([]);
  });

  it('returns similar pages for known page', () => {
    const similarPages = [{ id: 'other', title: 'Other', path: '/other', similarity: 50 }];
    const map = new Map([['page-1', { maxSimilarity: 50, avgSimilarity: 50, similarPages }]]);
    expect(getSimilarPages('page-1', map)).toEqual(similarPages);
  });
});
