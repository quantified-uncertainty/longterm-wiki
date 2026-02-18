/**
 * Tests for crux/auto-update/feed-fetcher.ts
 *
 * Focus areas:
 * - Exa API search: request shape, response mapping, date filtering
 * - Fallback behaviour: Exa disabled when EXA_API_KEY unset, falls through to LLM path
 * - fetchWebSearch: Exa results map to FeedItem correctly
 * - RSS parsing helpers (parseFeedXml via fetchRssFeed indirectly)
 * - Edge cases: empty results, missing fields, invalid dates
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────

// Mock fs so we don't touch the real filesystem
vi.mock('fs', () => ({
  readFileSync: vi.fn(() => 'sources:\n  []'),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

// Mock the LLM web-search fallback so tests don't hit Anthropic
vi.mock('../authoring/page-improver/api.ts', () => ({
  executeWebSearch: vi.fn(async () => ''),
}));

// Mock yaml parse/stringify
vi.mock('yaml', () => ({
  parse: vi.fn(() => ({ sources: [] })),
  stringify: vi.fn(() => ''),
}));

// Capture global fetch calls
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// ── Import after mocks ─────────────────────────────────────────────────────

import * as feedFetcher from './feed-fetcher.ts';
import { executeWebSearch } from '../authoring/page-improver/api.ts';

const mockLlmSearch = vi.mocked(executeWebSearch);

// ── Helpers ────────────────────────────────────────────────────────────────

function makeExaResponse(results: object[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ results }),
    text: async () => '',
  };
}

function makeExaResult(overrides: {
  title?: string;
  url?: string;
  publishedDate?: string;
  text?: string;
} = {}) {
  return {
    title: overrides.title ?? 'Test Article',
    url: overrides.url ?? 'https://example.com/article',
    publishedDate: overrides.publishedDate ?? '2026-02-01T00:00:00Z',
    text: overrides.text ?? 'Article summary text.',
  };
}

function makeSource(overrides: {
  id?: string;
  name?: string;
  type?: 'rss' | 'atom' | 'web-search';
  query?: string;
  categories?: string[];
  reliability?: 'high' | 'medium' | 'low';
  enabled?: boolean;
  url?: string;
} = {}) {
  return {
    id: overrides.id ?? 'test-source',
    name: overrides.name ?? 'Test Source',
    type: overrides.type ?? 'web-search',
    query: overrides.query ?? 'AI safety news',
    categories: overrides.categories ?? ['safety'],
    reliability: overrides.reliability ?? 'medium',
    enabled: overrides.enabled ?? true,
    url: overrides.url,
    frequency: 'daily' as const,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('fetchAllSources — Exa integration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: no env vars
    delete process.env.EXA_API_KEY;
  });

  afterEach(() => {
    delete process.env.EXA_API_KEY;
  });

  it('skips Exa and falls back to LLM search when EXA_API_KEY is not set', async () => {
    // No EXA_API_KEY in env
    mockLlmSearch.mockResolvedValue('');

    const { vi: _vi } = await import('vitest');
    const yaml = await import('yaml');
    vi.mocked(yaml.parse).mockReturnValue({
      sources: [makeSource()],
    });

    await feedFetcher.fetchAllSources();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockLlmSearch).toHaveBeenCalledOnce();
  });

  it('uses Exa when EXA_API_KEY is set', async () => {
    process.env.EXA_API_KEY = 'test-exa-key';

    const yaml = await import('yaml');
    vi.mocked(yaml.parse).mockReturnValue({
      sources: [makeSource({ query: 'AI alignment' })],
    });

    fetchMock.mockResolvedValue(makeExaResponse([makeExaResult()]));

    const result = await feedFetcher.fetchAllSources();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.exa.ai/search');
    expect(opts.method).toBe('POST');
    expect(opts.headers['x-api-key']).toBe('test-exa-key');
    const body = JSON.parse(opts.body);
    expect(body.query).toBe('AI alignment');
    expect(body.type).toBe('auto');
    expect(body.numResults).toBe(10);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe('Test Article');
    expect(result.items[0].url).toBe('https://example.com/article');
    expect(result.items[0].sourceId).toBe('test-source');
    expect(result.items[0].categories).toEqual(['safety']);
    expect(result.items[0].reliability).toBe('medium');
  });

  it('maps publishedDate from Exa result to YYYY-MM-DD format', async () => {
    process.env.EXA_API_KEY = 'test-exa-key';

    const yaml = await import('yaml');
    vi.mocked(yaml.parse).mockReturnValue({
      sources: [makeSource()],
    });

    fetchMock.mockResolvedValue(
      makeExaResponse([makeExaResult({ publishedDate: '2026-01-15T12:30:00Z' })])
    );

    const result = await feedFetcher.fetchAllSources();

    expect(result.items[0].publishedAt).toBe('2026-01-15');
  });

  it('falls back to today when publishedDate is absent', async () => {
    process.env.EXA_API_KEY = 'test-exa-key';

    const yaml = await import('yaml');
    vi.mocked(yaml.parse).mockReturnValue({
      sources: [makeSource()],
    });

    const resultWithoutDate = { title: 'No Date Article', url: 'https://example.com/2' };
    fetchMock.mockResolvedValue(makeExaResponse([resultWithoutDate]));

    const today = new Date().toISOString().slice(0, 10);
    const result = await feedFetcher.fetchAllSources();

    expect(result.items[0].publishedAt).toBe(today);
  });

  it('filters out Exa results missing title or url', async () => {
    process.env.EXA_API_KEY = 'test-exa-key';

    const yaml = await import('yaml');
    vi.mocked(yaml.parse).mockReturnValue({
      sources: [makeSource()],
    });

    fetchMock.mockResolvedValue(
      makeExaResponse([
        { title: '', url: 'https://example.com/no-title' },   // no title
        { title: 'No URL', url: '' },                          // no url
        makeExaResult({ title: 'Good Article' }),              // valid
      ])
    );

    const result = await feedFetcher.fetchAllSources();

    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe('Good Article');
  });

  it('falls back to LLM search when Exa returns a non-OK response', async () => {
    process.env.EXA_API_KEY = 'test-exa-key';

    const yaml = await import('yaml');
    vi.mocked(yaml.parse).mockReturnValue({
      sources: [makeSource()],
    });

    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });
    mockLlmSearch.mockResolvedValue('');

    const result = await feedFetcher.fetchAllSources();

    // Exa failed, fell back to LLM (which returned empty string → 0 items)
    expect(mockLlmSearch).toHaveBeenCalledOnce();
    expect(result.items).toHaveLength(0);
    expect(result.failedSources).toHaveLength(0); // fallback succeeded (returned [])
  });

  it('includes startPublishedDate in Exa request when since is provided', async () => {
    process.env.EXA_API_KEY = 'test-exa-key';

    const yaml = await import('yaml');
    vi.mocked(yaml.parse).mockReturnValue({
      sources: [makeSource()],
    });

    // Simulate a prior fetch time for this source
    const { existsSync, readFileSync } = await import('fs');
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      // Return a state file with a last_fetch_time for this source
      JSON.stringify({ last_fetch_times: { 'test-source': '2026-02-01T00:00:00Z' }, seen_items: {} })
    );
    // yaml.parse needs to handle both calls (sources config + state)
    vi.mocked(yaml.parse)
      .mockReturnValueOnce({ sources: [makeSource()] })
      .mockReturnValueOnce({ last_fetch_times: { 'test-source': '2026-02-01T00:00:00Z' }, seen_items: {} });

    fetchMock.mockResolvedValue(makeExaResponse([]));

    await feedFetcher.fetchAllSources();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.startPublishedDate).toBeDefined();
    expect(body.startPublishedDate).toContain('2026-02-01');
  });

  it('handles empty Exa results array gracefully', async () => {
    process.env.EXA_API_KEY = 'test-exa-key';

    const yaml = await import('yaml');
    vi.mocked(yaml.parse).mockReturnValue({
      sources: [makeSource()],
    });

    fetchMock.mockResolvedValue(makeExaResponse([]));

    const result = await feedFetcher.fetchAllSources();

    expect(result.items).toHaveLength(0);
    expect(result.fetchedSources).toContain('test-source');
    expect(result.failedSources).toHaveLength(0);
  });

  it('truncates Exa text summary to 500 chars', async () => {
    process.env.EXA_API_KEY = 'test-exa-key';

    const yaml = await import('yaml');
    vi.mocked(yaml.parse).mockReturnValue({
      sources: [makeSource()],
    });

    const longText = 'A'.repeat(1000);
    fetchMock.mockResolvedValue(makeExaResponse([makeExaResult({ text: longText })]));

    const result = await feedFetcher.fetchAllSources();

    expect(result.items[0].summary.length).toBeLessThanOrEqual(500);
  });
});
