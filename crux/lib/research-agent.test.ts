/**
 * Tests for research-agent.ts
 *
 * Covers:
 *  - Multi-source search with graceful degradation (missing keys → skip provider)
 *  - URL deduplication across providers
 *  - Source fetching via source-fetcher (mocked)
 *  - Fact extraction via Haiku (mocked)
 *  - Budget cap enforcement
 *  - ResearchResult shape and metadata
 *
 * All network calls are mocked — tests run fully offline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runResearch } from './research-agent.ts';
import type { ResearchRequest } from './research-agent.ts';

// ---------------------------------------------------------------------------
// Mock source-fetcher — avoid real network calls
// ---------------------------------------------------------------------------

vi.mock('./source-fetcher.ts', () => ({
  fetchSources: vi.fn(async (requests: Array<{ url: string }>) =>
    requests.map((req, i) => ({
      url: req.url,
      title: `Title for ${req.url}`,
      fetchedAt: new Date().toISOString(),
      content: `This is content about AI safety for URL ${i + 1}. It contains facts about organizations and funding.`,
      relevantExcerpts: [`Relevant excerpt from ${req.url}`],
      status: 'ok' as const,
      resource: undefined,
    }))
  ),
}));

// ---------------------------------------------------------------------------
// Mock LLM layer — avoid real API calls
// ---------------------------------------------------------------------------

vi.mock('./llm.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./llm.ts')>();
  return {
    ...actual,
    createLlmClient: vi.fn(() => ({})),
    streamingCreate: vi.fn(async () => ({
      content: [{ type: 'text', text: '["Fact 1 about the topic.", "Fact 2 about funding.", "Fact 3 about research."]' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    })),
    extractText: vi.fn((response: { content: Array<{ type: string; text: string }> }) =>
      response.content
        .filter((b: { type: string }) => b.type === 'text')
        .map((b: { type: string; text: string }) => b.text)
        .join('\n')
    ),
    MODELS: { haiku: 'claude-haiku-4-5-20251001', sonnet: 'claude-sonnet-4-6' },
  };
});

// ---------------------------------------------------------------------------
// Mock fetch — control search API responses
// ---------------------------------------------------------------------------

const mockExaResponse = {
  results: [
    { title: 'AI Safety Overview', url: 'https://aisafety.com/overview', text: 'Overview of AI safety.' },
    { title: 'Alignment Research', url: 'https://alignment.org/research', text: 'Research on alignment.' },
    { title: 'Shared URL', url: 'https://shared.example.com/page', text: 'Shared across providers.' },
  ],
};

const mockPerplexityResponse = {
  choices: [{
    message: {
      content: '[{"url":"https://perplexity.example.com/article","title":"Perplexity Source"},{"url":"https://shared.example.com/page","title":"Shared URL (Perplexity)"}]',
    },
  }],
  citations: ['https://perplexity.example.com/article', 'https://shared.example.com/page'],
  usage: { cost: 0.0015 },
};

const mockScryResponse = {
  rows: [
    { title: 'EA Forum Post', uri: 'https://forum.effectivealtruism.org/posts/abc', snippet: 'Discussion on AI safety.' },
    { title: 'LessWrong Post', uri: 'https://lesswrong.com/posts/xyz', snippet: 'Alignment post.' },
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetchMock(scenario: 'all-success' | 'exa-only' | 'no-keys' | 'scry-fails') {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? init.body : '';

    // Exa search
    if (url === 'https://api.exa.ai/search') {
      if (scenario === 'no-keys') throw new Error('Connection refused');
      return {
        ok: true,
        status: 200,
        json: async () => mockExaResponse,
        text: async () => JSON.stringify(mockExaResponse),
      };
    }

    // Perplexity / OpenRouter
    if (url === 'https://openrouter.ai/api/v1/chat/completions') {
      if (scenario === 'exa-only') throw new Error('Connection refused');
      return {
        ok: true,
        status: 200,
        json: async () => mockPerplexityResponse,
        text: async () => JSON.stringify(mockPerplexityResponse),
      };
    }

    // SCRY search
    if (url === 'https://api.exopriors.com/v1/scry/query') {
      if (scenario === 'scry-fails') throw new Error('SCRY unavailable');
      return {
        ok: true,
        status: 200,
        json: async () => mockScryResponse,
        text: async () => JSON.stringify(mockScryResponse),
      };
    }

    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runResearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set a known environment for tests
    process.env.EXA_API_KEY = 'test-exa-key';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    delete process.env.SCRY_API_KEY;
  });

  it('returns SourceCacheEntry[] with correct shape', async () => {
    vi.stubGlobal('fetch', makeFetchMock('all-success'));

    const request: ResearchRequest = {
      topic: 'AI safety research',
      config: { useExa: true, usePerplexity: true, useScry: true, maxResultsPerSource: 3 },
    };

    const result = await runResearch(request);

    expect(result.sources).toBeInstanceOf(Array);
    expect(result.sources.length).toBeGreaterThan(0);

    // Each source must have required SourceCacheEntry fields
    for (const src of result.sources) {
      expect(src).toHaveProperty('id');
      expect(src).toHaveProperty('url');
      expect(src).toHaveProperty('title');
      expect(src).toHaveProperty('content');
      expect(src.id).toMatch(/^SRC-\d+$/);
    }
  });

  it('deduplicates URLs from multiple providers', async () => {
    vi.stubGlobal('fetch', makeFetchMock('all-success'));

    const result = await runResearch({
      topic: 'AI safety',
      config: { useExa: true, usePerplexity: true, useScry: true, maxResultsPerSource: 3 },
    });

    // 'shared.example.com/page' appears in both Exa and Perplexity
    const urls = result.sources.map(s => s.url);
    const sharedCount = urls.filter(u => u.includes('shared.example.com')).length;
    expect(sharedCount).toBe(1); // deduplicated to 1

    expect(result.metadata.urlsDeduplicated).toBeGreaterThan(0);
  });

  it('tracks metadata fields correctly', async () => {
    vi.stubGlobal('fetch', makeFetchMock('all-success'));

    const result = await runResearch({
      topic: 'AI safety',
      config: { useExa: true, usePerplexity: true, useScry: true },
    });

    expect(result.metadata).toHaveProperty('sourcesSearched');
    expect(result.metadata).toHaveProperty('urlsFound');
    expect(result.metadata).toHaveProperty('urlsFetched');
    expect(result.metadata).toHaveProperty('urlsDeduplicated');
    expect(result.metadata).toHaveProperty('totalCost');
    expect(result.metadata).toHaveProperty('costBreakdown');
    expect(result.metadata).toHaveProperty('durationMs');
    expect(result.metadata.costBreakdown).toHaveProperty('searchCost');
    expect(result.metadata.costBreakdown).toHaveProperty('factExtractionCost');
    expect(result.metadata.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('includes Perplexity cost in totalCost', async () => {
    vi.stubGlobal('fetch', makeFetchMock('all-success'));

    const result = await runResearch({
      topic: 'AI safety',
      config: { useExa: true, usePerplexity: true, useScry: false },
    });

    // Perplexity mock returns cost: 0.0015
    expect(result.metadata.costBreakdown.searchCost).toBeCloseTo(0.0015, 5);
  });

  it('degrades gracefully when Perplexity fails (exa-only scenario)', async () => {
    vi.stubGlobal('fetch', makeFetchMock('exa-only'));

    const result = await runResearch({
      topic: 'AI safety',
      config: { useExa: true, usePerplexity: true, useScry: false },
    });

    // Should still return sources from Exa
    expect(result.sources.length).toBeGreaterThan(0);
    // Perplexity failed → not in sourcesSearched
    expect(result.metadata.sourcesSearched).not.toContain('perplexity');
    // Exa succeeded → in sourcesSearched
    expect(result.metadata.sourcesSearched).toContain('exa');
  });

  it('degrades gracefully when SCRY fails', async () => {
    vi.stubGlobal('fetch', makeFetchMock('scry-fails'));

    const result = await runResearch({
      topic: 'AI safety',
      config: { useExa: true, usePerplexity: false, useScry: true },
    });

    // Exa sources should still be returned
    expect(result.sources.length).toBeGreaterThan(0);
    // SCRY failed → not in sourcesSearched
    expect(result.metadata.sourcesSearched).not.toContain('scry');
  });

  it('skips providers when config explicitly disables them', async () => {
    const fetchMock = makeFetchMock('all-success');
    vi.stubGlobal('fetch', fetchMock);

    await runResearch({
      topic: 'AI safety',
      config: { useExa: false, usePerplexity: false, useScry: true },
    });

    // Exa and Perplexity should NOT have been called
    const calledUrls = fetchMock.mock.calls.map((call) => call[0] as string);
    expect(calledUrls.some(u => u.includes('exa.ai'))).toBe(false);
    expect(calledUrls.some(u => u.includes('openrouter.ai'))).toBe(false);
  });

  it('extracts facts when extractFacts is true', async () => {
    vi.stubGlobal('fetch', makeFetchMock('all-success'));

    const result = await runResearch({
      topic: 'AI safety',
      config: { useExa: true, usePerplexity: false, useScry: false, extractFacts: true },
    });

    // Mock LLM returns 3 facts per source
    const sourcesWithFacts = result.sources.filter(s => s.facts && s.facts.length > 0);
    expect(sourcesWithFacts.length).toBeGreaterThan(0);
    expect(sourcesWithFacts[0].facts).toContain('Fact 1 about the topic.');
  });

  it('skips fact extraction when extractFacts is false', async () => {
    vi.stubGlobal('fetch', makeFetchMock('all-success'));

    const result = await runResearch({
      topic: 'AI safety',
      config: { useExa: true, usePerplexity: false, useScry: false, extractFacts: false },
    });

    // No sources should have facts
    const sourcesWithFacts = result.sources.filter(s => s.facts && s.facts.length > 0);
    expect(sourcesWithFacts.length).toBe(0);
    expect(result.metadata.costBreakdown.factExtractionCost).toBe(0);
  });

  it('uses page context to focus the query', async () => {
    const fetchMock = makeFetchMock('all-success');
    vi.stubGlobal('fetch', fetchMock);

    await runResearch({
      topic: 'funding',
      pageContext: { title: 'Anthropic', type: 'organization', entityId: 'anthropic' },
      config: { useExa: true, usePerplexity: false, useScry: false },
    });

    // Verify that the Exa call was made with a query that includes the page context
    const exaCall = fetchMock.mock.calls.find(
      (call) => (call[0] as string) === 'https://api.exa.ai/search'
    );
    expect(exaCall).toBeDefined();
    const body = JSON.parse(exaCall![1]!.body as string);
    expect(body.query).toContain('Anthropic');
  });

  it('respects budget cap and stops fact extraction', async () => {
    vi.stubGlobal('fetch', makeFetchMock('all-success'));

    const result = await runResearch({
      topic: 'AI safety',
      config: { useExa: true, usePerplexity: true, useScry: true, extractFacts: true },
      budgetCap: 0, // Zero budget: no fact extraction should happen
    });

    // With budgetCap=0, fact extraction should be skipped for all sources
    // (totalCost starts at searchCost from Perplexity=0.0015 > budgetCap=0)
    expect(result.metadata.costBreakdown.factExtractionCost).toBe(0);
  });

  it('returns empty sources when all providers fail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Network unreachable'); }));

    const result = await runResearch({
      topic: 'AI safety',
      config: { useExa: true, usePerplexity: true, useScry: true },
    });

    expect(result.sources).toHaveLength(0);
    expect(result.metadata.sourcesSearched).toHaveLength(0);
    expect(result.metadata.urlsFound).toBe(0);
  });

  it('assigns sequential SRC-N IDs to sources', async () => {
    vi.stubGlobal('fetch', makeFetchMock('all-success'));

    const result = await runResearch({
      topic: 'AI safety',
      config: { useExa: true, usePerplexity: false, useScry: false },
    });

    for (let i = 0; i < result.sources.length; i++) {
      expect(result.sources[i].id).toBe(`SRC-${i + 1}`);
    }
  });
});
