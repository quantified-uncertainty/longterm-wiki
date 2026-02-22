/**
 * Tests for the source cache adapter (buildSourceCache).
 *
 * Tests the conversion from research sources + fetched content → SourceCacheEntry[].
 * All tests are offline — no network calls.
 */

import { describe, it, expect } from 'vitest';
import { buildSourceCache } from './research.ts';
import type { FetchedSource } from '../../../lib/source-fetcher.ts';

function makeFetchedSource(overrides: Partial<FetchedSource> = {}): FetchedSource {
  return {
    url: 'https://example.com/article',
    title: 'Example Article',
    fetchedAt: '2026-02-22T12:00:00Z',
    content: 'This is the full content of the article. It has enough characters to pass the threshold easily.',
    relevantExcerpts: [],
    status: 'ok',
    ...overrides,
  };
}

describe('buildSourceCache', () => {
  it('converts research sources with fetched content into SourceCacheEntry[]', () => {
    const researchSources = [
      { topic: 'funding', title: 'Funding Article', url: 'https://example.com/a', author: 'Alice', date: '2025-01-15', facts: ['Raised $100M'], relevance: 'high' },
    ];
    const fetched: FetchedSource[] = [
      makeFetchedSource({ url: 'https://example.com/a', title: 'Funding Article (fetched)', content: 'Full article about raising $100M in Series B funding.' }),
    ];

    const cache = buildSourceCache(researchSources, fetched);
    expect(cache).toHaveLength(1);
    expect(cache[0].id).toBe('SRC-1');
    expect(cache[0].url).toBe('https://example.com/a');
    expect(cache[0].title).toBe('Funding Article (fetched)'); // prefers fetched title
    expect(cache[0].author).toBe('Alice');
    expect(cache[0].date).toBe('2025-01-15');
    expect(cache[0].content).toContain('$100M');
    expect(cache[0].facts).toEqual(['Raised $100M']);
  });

  it('uses relevant excerpts when available instead of raw content', () => {
    const researchSources = [
      { topic: 'safety', title: 'Safety Report', url: 'https://example.com/b', facts: [], relevance: 'high' },
    ];
    const fetched: FetchedSource[] = [
      makeFetchedSource({
        url: 'https://example.com/b',
        content: 'Very long article content that is definitely long enough to pass the threshold check for minimum content length.',
        relevantExcerpts: ['Key safety finding: RSPs are effective', 'Second excerpt about evals'],
      }),
    ];

    const cache = buildSourceCache(researchSources, fetched);
    expect(cache[0].content).toContain('Key safety finding');
    expect(cache[0].content).toContain('Second excerpt about evals');
    expect(cache[0].content).toContain('---'); // separator between excerpts
  });

  it('falls back to LLM-extracted facts when source is dead', () => {
    const researchSources = [
      { topic: 'history', title: 'Dead Link', url: 'https://example.com/dead', facts: ['Founded in 2020', 'Grew to 500 employees'], relevance: 'medium' },
    ];
    const fetched: FetchedSource[] = [
      makeFetchedSource({ url: 'https://example.com/dead', content: '', status: 'dead' }),
    ];

    const cache = buildSourceCache(researchSources, fetched);
    expect(cache[0].content).toBe('Founded in 2020\nGrew to 500 employees');
    expect(cache[0].facts).toEqual(['Founded in 2020', 'Grew to 500 employees']);
  });

  it('falls back to facts when source is paywalled', () => {
    const researchSources = [
      { topic: 'revenue', title: 'Paywalled', url: 'https://example.com/paywall', facts: ['Revenue of $2B'], relevance: 'high' },
    ];
    const fetched: FetchedSource[] = [
      makeFetchedSource({ url: 'https://example.com/paywall', content: 'Subscribe to read more', status: 'paywall' }),
    ];

    const cache = buildSourceCache(researchSources, fetched);
    expect(cache[0].content).toBe('Revenue of $2B');
  });

  it('falls back to facts when fetched content is too short', () => {
    const researchSources = [
      { topic: 'test', title: 'Short Page', url: 'https://example.com/short', facts: ['Key fact'], relevance: 'low' },
    ];
    const fetched: FetchedSource[] = [
      makeFetchedSource({ url: 'https://example.com/short', content: 'Too short', status: 'ok' }),
    ];

    const cache = buildSourceCache(researchSources, fetched);
    expect(cache[0].content).toBe('Key fact');
  });

  it('skips sources without URLs', () => {
    const researchSources = [
      { topic: 'general', title: 'No URL', url: '', facts: ['Some fact'], relevance: 'low' },
    ];

    const cache = buildSourceCache(researchSources, []);
    expect(cache).toHaveLength(0);
  });

  it('handles multiple sources with sequential IDs', () => {
    const researchSources = [
      { topic: 'a', title: 'First', url: 'https://example.com/1', facts: ['Fact 1'], relevance: 'high' },
      { topic: 'b', title: 'Second', url: 'https://example.com/2', facts: ['Fact 2'], relevance: 'high' },
      { topic: 'c', title: 'Third', url: 'https://example.com/3', facts: ['Fact 3'], relevance: 'medium' },
    ];
    const fetched: FetchedSource[] = [
      makeFetchedSource({ url: 'https://example.com/1' }),
      makeFetchedSource({ url: 'https://example.com/2' }),
      makeFetchedSource({ url: 'https://example.com/3' }),
    ];

    const cache = buildSourceCache(researchSources, fetched);
    expect(cache).toHaveLength(3);
    expect(cache[0].id).toBe('SRC-1');
    expect(cache[1].id).toBe('SRC-2');
    expect(cache[2].id).toBe('SRC-3');
  });

  it('handles sources with no fetched match (URL not found)', () => {
    const researchSources = [
      { topic: 'test', title: 'Unfetched', url: 'https://example.com/unfetched', facts: ['Fallback fact'], relevance: 'high' },
    ];

    const cache = buildSourceCache(researchSources, []);
    expect(cache).toHaveLength(1);
    expect(cache[0].content).toBe('Fallback fact');
    expect(cache[0].title).toBe('Unfetched'); // falls back to research title
  });

  it('truncates long content to 5000 chars', () => {
    const longContent = 'A'.repeat(10_000);
    const researchSources = [
      { topic: 'test', title: 'Long', url: 'https://example.com/long', facts: [], relevance: 'high' },
    ];
    const fetched: FetchedSource[] = [
      makeFetchedSource({ url: 'https://example.com/long', content: longContent }),
    ];

    const cache = buildSourceCache(researchSources, fetched);
    expect(cache[0].content.length).toBe(5000);
  });
});
