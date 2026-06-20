/**
 * Tests for crux/lib/sourcing/suggest-urls.ts (QUA-64).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildSearchQuery, suggestUrls } from './suggest-urls.ts';
import { hostMatches } from '@longterm-wiki/url-utils';

// Mock the research-agent module's search fns + api-keys.
vi.mock('../search/research-agent.ts', () => ({
  searchExa: vi.fn(),
  searchPerplexity: vi.fn(),
}));

vi.mock('../api-keys.ts', () => ({
  getApiKey: vi.fn(),
  SCRY_PUBLIC_KEY: 'test-scry-public',
}));

import { searchExa, searchPerplexity } from '../search/research-agent.ts';
import { getApiKey } from '../api-keys.ts';

const mockSearchExa = vi.mocked(searchExa);
const mockSearchPerplexity = vi.mocked(searchPerplexity);
const mockGetApiKey = vi.mocked(getApiKey);

describe('buildSearchQuery', () => {
  it('quotes the entity name', () => {
    const q = buildSearchQuery({
      entityName: 'Anthropic',
      claimText: 'Anthropic had 500 employees in 2024',
    });
    expect(q).toContain('"Anthropic"');
    expect(q).toContain('Anthropic had 500 employees in 2024');
  });

  it('includes field name when provided, with underscores replaced', () => {
    const q = buildSearchQuery({
      entityName: 'OpenAI',
      claimText: '$80B valuation',
      fieldName: 'valuation_usd',
    });
    expect(q).toContain('valuation usd');
  });

  it('truncates long claims', () => {
    const long = 'x'.repeat(500);
    const q = buildSearchQuery({ entityName: 'Acme', claimText: long });
    // 300 is the hard cap; claim alone is 160+ellipsis.
    expect(q.length).toBeLessThanOrEqual(300);
    expect(q).toContain('...');
  });

  it('returns non-empty query even with only entityName', () => {
    const q = buildSearchQuery({ entityName: 'Foo', claimText: '' });
    expect(q).toContain('"Foo"');
  });
});

describe('suggestUrls', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: both keys configured.
    mockGetApiKey.mockImplementation((name: string) =>
      name === 'EXA_API_KEY' || name === 'OPENROUTER_API_KEY' ? 'test-key' : undefined
    );
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('returns candidates from both providers, deduped and capped', async () => {
    mockSearchExa.mockResolvedValue([
      { url: 'https://a.com/page', title: 'A Page', snippet: 'a snip', provider: 'exa' },
      { url: 'https://b.com/page', title: 'B Page', snippet: 'b snip', provider: 'exa' },
    ]);
    mockSearchPerplexity.mockResolvedValue({
      hits: [
        { url: 'https://b.com/page', title: 'B Dup', provider: 'perplexity' }, // dup
        { url: 'https://c.com/page', title: 'C Page', provider: 'perplexity' },
      ],
      cost: 0.002,
    });

    const result = await suggestUrls({
      entityName: 'Foo',
      claimText: 'Foo has 100 employees',
      maxCandidates: 3,
    });

    expect(result.candidates).toHaveLength(3);
    const urls = result.candidates.map((c) => c.url);
    // b.com appears once (dedup).
    expect(urls.filter((u) => hostMatches(u, 'b.com'))).toHaveLength(1);
    expect(urls).toEqual(
      expect.arrayContaining(['https://a.com/page', 'https://b.com/page', 'https://c.com/page'])
    );
    expect(result.providersUsed.sort()).toEqual(['exa', 'perplexity']);
    expect(result.costUsd).toBeCloseTo(0.002);
  });

  it('filters out the existing source URL', async () => {
    mockSearchExa.mockResolvedValue([
      { url: 'https://existing.com/bad', title: 'Existing', provider: 'exa' },
      { url: 'https://good.com/page', title: 'Good', provider: 'exa' },
    ]);
    mockSearchPerplexity.mockResolvedValue({ hits: [], cost: 0 });

    const result = await suggestUrls({
      entityName: 'Bar',
      claimText: 'bar fact',
      existingUrl: 'https://existing.com/bad',
      maxCandidates: 3,
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].url).toBe('https://good.com/page');
  });

  it('filters out existing URL after normalization (trailing slash / tracking params)', async () => {
    mockSearchExa.mockResolvedValue([
      { url: 'https://existing.com/bad', title: 'Existing', provider: 'exa' },
      { url: 'https://good.com/page', title: 'Good', provider: 'exa' },
    ]);
    mockSearchPerplexity.mockResolvedValue({ hits: [], cost: 0 });

    const result = await suggestUrls({
      entityName: 'Bar',
      claimText: 'fact',
      existingUrl: 'https://existing.com/bad/?utm_source=x',
      maxCandidates: 3,
    });

    expect(result.candidates.map((c) => c.url)).not.toContain('https://existing.com/bad');
  });

  it('skips provider when API key is missing', async () => {
    mockGetApiKey.mockImplementation((name: string) =>
      name === 'EXA_API_KEY' ? 'test-key' : undefined
    );
    mockSearchExa.mockResolvedValue([
      { url: 'https://a.com/p', title: 'A', provider: 'exa' },
    ]);

    const result = await suggestUrls({ entityName: 'X', claimText: 'y' });

    expect(result.providersUsed).toEqual(['exa']);
    expect(result.providersSkipped).toContain('perplexity:no-key');
    expect(mockSearchPerplexity).not.toHaveBeenCalled();
    expect(result.candidates).toHaveLength(1);
  });

  it('degrades gracefully when both providers fail', async () => {
    mockSearchExa.mockRejectedValue(new Error('Exa down'));
    mockSearchPerplexity.mockRejectedValue(new Error('Perplexity down'));

    const result = await suggestUrls({ entityName: 'X', claimText: 'y' });

    expect(result.candidates).toEqual([]);
    expect(result.providersSkipped.some((p) => p.startsWith('exa:'))).toBe(true);
    expect(result.providersSkipped.some((p) => p.startsWith('perplexity:'))).toBe(true);
    expect(result.costUsd).toBe(0);
  });

  it('returns an empty result when no providers are configured', async () => {
    mockGetApiKey.mockReturnValue(undefined);

    const result = await suggestUrls({ entityName: 'X', claimText: 'y' });

    expect(result.candidates).toEqual([]);
    expect(result.providersUsed).toEqual([]);
    expect(result.providersSkipped).toEqual(
      expect.arrayContaining(['exa:no-key', 'perplexity:no-key'])
    );
    expect(mockSearchExa).not.toHaveBeenCalled();
    expect(mockSearchPerplexity).not.toHaveBeenCalled();
  });

  it('respects maxCandidates', async () => {
    mockSearchExa.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({
        url: `https://ex.com/${i}`,
        title: `t${i}`,
        provider: 'exa',
      }))
    );
    mockSearchPerplexity.mockResolvedValue({ hits: [], cost: 0 });

    const result = await suggestUrls({
      entityName: 'X',
      claimText: 'y',
      maxCandidates: 2,
    });

    expect(result.candidates).toHaveLength(2);
  });

  it('drops candidates that point at a different Wikidata entity (subject-identity gate, QUA-724)', async () => {
    // Anthropic Q108542504 vs xAI Q117104853 — the canonical mismatch from QUA-722.
    // (Note: dedupeHits normalizes www-prefixed hosts; we use bare wikidata.org
    // so the asserted URLs match the normalized output.)
    mockSearchExa.mockResolvedValue([
      { url: 'https://wikidata.org/wiki/Q117104853', title: 'xAI', provider: 'exa' },
      { url: 'https://wikidata.org/wiki/Q108542504', title: 'Anthropic', provider: 'exa' },
      { url: 'https://reuters.com/anthropic-news', title: 'Reuters', provider: 'exa' },
    ]);
    mockSearchPerplexity.mockResolvedValue({ hits: [], cost: 0 });

    const result = await suggestUrls({
      entityName: 'Anthropic',
      claimText: 'Anthropic raised $13B Series F',
      entityWikidataQid: 'Q108542504',
      maxCandidates: 3,
    });

    const urls = result.candidates.map((c) => c.url);
    expect(urls).not.toContain('https://wikidata.org/wiki/Q117104853');
    expect(urls).toContain('https://wikidata.org/wiki/Q108542504');
    expect(urls).toContain('https://reuters.com/anthropic-news');
    expect(result.subjectMismatches).toHaveLength(1);
    expect(result.subjectMismatches[0]).toEqual({
      url: 'https://wikidata.org/wiki/Q117104853',
      candidateQid: 'Q117104853',
      entityQid: 'Q108542504',
    });
  });

  it('subject-identity gate is fail-open when entityWikidataQid is omitted', async () => {
    // No entityWikidataQid → all candidates pass even when one is a wikidata
    // URL that would mismatch any other entity.
    mockSearchExa.mockResolvedValue([
      { url: 'https://wikidata.org/wiki/Q117104853', title: 'xAI', provider: 'exa' },
      { url: 'https://reuters.com/news', title: 'R', provider: 'exa' },
    ]);
    mockSearchPerplexity.mockResolvedValue({ hits: [], cost: 0 });

    const result = await suggestUrls({
      entityName: 'Anthropic',
      claimText: 'fact',
      maxCandidates: 3,
    });

    expect(result.candidates).toHaveLength(2);
    expect(result.subjectMismatches).toEqual([]);
  });

  it('sets sourceProvider per candidate from the search provider', async () => {
    mockSearchExa.mockResolvedValue([
      { url: 'https://a.com/p', title: 'A', provider: 'exa' },
    ]);
    mockSearchPerplexity.mockResolvedValue({
      hits: [{ url: 'https://b.com/p', title: 'B', provider: 'perplexity' }],
      cost: 0,
    });

    const result = await suggestUrls({
      entityName: 'X',
      claimText: 'y',
      maxCandidates: 3,
    });

    const byUrl = new Map(result.candidates.map((c) => [c.url, c.sourceProvider]));
    expect(byUrl.get('https://a.com/p')).toBe('exa');
    expect(byUrl.get('https://b.com/p')).toBe('perplexity');
  });
});
