/**
 * Tests for source-fetcher.ts
 *
 * Covers: FetchedSource interface, excerpt extraction, paywall detection,
 * in-memory cache, error handling, and fetchSources batch function.
 *
 * Network calls are mocked via vitest's built-in fetch mock so tests
 * run offline and deterministically.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  extractRelevantExcerpts,
  fetchSource,
  fetchSources,
  fetchAndVerifyClaim,
  requestsFromResourceIds,
  clearSessionCache,
  sessionCacheSize,
  sessionCacheEvictions,
  type FetchRequest,
  type FetchedSource,
} from './source-fetcher.ts';

// Mock the SQLite knowledge-db layer so tests are fully offline and deterministic.
// The session-level in-memory cache is still exercised (it lives in source-fetcher.ts).
vi.mock('./knowledge-db.ts', () => ({
  citationContent: {
    getByUrl: vi.fn(() => null),
    upsert: vi.fn(),
  },
}));

// Mock the wiki-server citations client so PostgreSQL calls don't require a server.
vi.mock('./wiki-server/citations.ts', () => ({
  upsertCitationContent: vi.fn().mockResolvedValue({ ok: true, data: { url: 'https://example.com' } }),
  getCitationContentByUrl: vi.fn().mockResolvedValue({ ok: false, error: 'unavailable', message: 'no server' }),
}));

// Mock the resource-lookup layer so tests don't require YAML files on disk.
const mockResources = new Map<string, { id: string; url: string; title: string; type: string; summary?: string; authors?: string[]; tags?: string[] }>([
  ['res-safety-paper', {
    id: 'res-safety-paper',
    url: 'https://example.com/safety-paper',
    title: 'AI Safety Research Paper',
    type: 'paper',
    summary: 'A paper about AI safety techniques',
    authors: ['Jane Smith'],
    tags: ['safety', 'alignment'],
  }],
  ['res-blog-post', {
    id: 'res-blog-post',
    url: 'https://example.com/blog',
    title: 'Alignment Blog Post',
    type: 'blog',
  }],
]);

vi.mock('./resource-lookup.ts', () => ({
  getResourceById: vi.fn((id: string) => mockResources.get(id) ?? null),
  getResourceByUrl: vi.fn((url: string) => {
    for (const r of mockResources.values()) {
      if (r.url === url || r.url === url.replace(/\/$/, '')) return r;
    }
    return null;
  }),
  updateResourceFetchStatus: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetchResponse(opts: {
  status?: number;
  contentType?: string;
  body?: string;
}): Response {
  const { status = 200, contentType = 'text/html', body = '' } = opts;
  return new Response(body, {
    status,
    headers: { 'content-type': contentType },
  });
}

const SAMPLE_HTML = `
<html>
<head><title>AI Safety Funding Report 2023</title></head>
<body>
<nav>Site navigation</nav>
<main>
<h1>Overview</h1>
<p>Global spending on AI safety research reached an estimated $100 million in 2023,
representing a significant increase from prior years.</p>

<p>Several large funders have dramatically increased their commitments. Open Philanthropy
allocated over $50 million to AI safety organizations in 2023 alone.</p>

<p>The field now includes over 500 researchers worldwide, compared to fewer than 50
just a decade ago.</p>

<h2>Key Organizations</h2>
<p>MIRI, Anthropic, and DeepMind safety teams are the top recipients of philanthropic
funding according to available grant data.</p>
</main>
<footer>Footer content</footer>
</body>
</html>
`;

const PAYWALL_HTML = `
<html>
<head><title>Premium Article</title></head>
<body>
<p>Subscribe to read the full article.</p>
<p>This content is for subscribers only. Subscribe to read unlimited access.</p>
</body>
</html>
`;

// ---------------------------------------------------------------------------
// extractRelevantExcerpts
// ---------------------------------------------------------------------------

describe('extractRelevantExcerpts', () => {
  const sampleContent = `
Global spending on AI safety research reached an estimated $100 million in 2023,
representing a significant increase from prior years.

Several large funders have dramatically increased their commitments. Open Philanthropy
allocated over $50 million to AI safety organizations in 2023 alone.

The field now includes over 500 researchers worldwide, compared to fewer than 50
just a decade ago.

MIRI, Anthropic, and DeepMind safety teams are the top recipients of philanthropic
funding according to available grant data.

Unrelated paragraph about climate change and ocean temperatures has nothing to do with the query.
`.trim();

  it('returns paragraphs matching the query', () => {
    const excerpts = extractRelevantExcerpts(sampleContent, 'AI safety funding');
    expect(excerpts.length).toBeGreaterThan(0);
    expect(excerpts.some(e => e.includes('100 million') || e.includes('50 million'))).toBe(true);
  });

  it('ranks more relevant paragraphs higher', () => {
    const excerpts = extractRelevantExcerpts(sampleContent, 'Open Philanthropy funding AI safety');
    expect(excerpts[0]).toContain('Open Philanthropy');
  });

  it('excludes paragraphs with zero keyword matches', () => {
    const excerpts = extractRelevantExcerpts(sampleContent, 'AI safety funding');
    // The climate change paragraph should not appear
    expect(excerpts.some(e => e.includes('climate change'))).toBe(false);
  });

  it('returns empty array for empty query', () => {
    const excerpts = extractRelevantExcerpts(sampleContent, '');
    expect(excerpts).toEqual([]);
  });

  it('returns empty array when no paragraphs match', () => {
    const excerpts = extractRelevantExcerpts(sampleContent, 'quantum computing hardware');
    expect(excerpts).toEqual([]);
  });

  it('respects maxExcerpts limit', () => {
    const excerpts = extractRelevantExcerpts(sampleContent, 'AI safety funding research', 2);
    expect(excerpts.length).toBeLessThanOrEqual(2);
  });

  it('handles stopwords gracefully', () => {
    // "the and for" are all stopwords — treated as empty query
    const excerpts = extractRelevantExcerpts(sampleContent, 'the and for');
    expect(excerpts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetchSource — with mocked fetch
// ---------------------------------------------------------------------------

describe('fetchSource', () => {
  beforeEach(() => {
    clearSessionCache();
    vi.restoreAllMocks();
  });

  it('returns ok status and content for successful HTML fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse({
      body: SAMPLE_HTML,
    })));

    const result = await fetchSource({ url: 'https://example.com/report', extractMode: 'full' });

    expect(result.status).toBe('ok');
    expect(result.title).toBe('AI Safety Funding Report 2023');
    expect(result.content).toContain('100 million');
    expect(result.url).toBe('https://example.com/report');
    expect(result.fetchedAt).toBeTruthy();
  });

  it('returns relevant excerpts when extractMode=relevant and query provided', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse({
      body: SAMPLE_HTML,
    })));

    const result = await fetchSource({
      url: 'https://example.com/report',
      extractMode: 'relevant',
      query: 'Open Philanthropy funding AI safety',
    });

    expect(result.status).toBe('ok');
    expect(result.relevantExcerpts.length).toBeGreaterThan(0);
    expect(result.relevantExcerpts.some(e => e.includes('Open Philanthropy'))).toBe(true);
  });

  it('returns empty relevantExcerpts when extractMode=full', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse({
      body: SAMPLE_HTML,
    })));

    const result = await fetchSource({
      url: 'https://example.com/full',
      extractMode: 'full',
      query: 'AI safety', // ignored because extractMode=full
    });

    expect(result.relevantExcerpts).toEqual([]);
  });

  it('returns dead status for 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse({ status: 404 })));

    const result = await fetchSource({ url: 'https://example.com/gone', extractMode: 'full' });

    expect(result.status).toBe('dead');
    expect(result.content).toBe('');
  });

  it('returns dead status for 410', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse({ status: 410 })));

    const result = await fetchSource({ url: 'https://example.com/removed', extractMode: 'full' });

    expect(result.status).toBe('dead');
  });

  it('returns error status on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await fetchSource({ url: 'https://unreachable.example.com', extractMode: 'full' });

    expect(result.status).toBe('error');
    expect(result.content).toBe('');
  });

  it('returns paywall status when content contains paywall signals', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse({
      body: PAYWALL_HTML,
    })));

    const result = await fetchSource({ url: 'https://newspaper.com/article', extractMode: 'full' });

    expect(result.status).toBe('paywall');
  });

  it('caches results in session cache', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeFetchResponse({ body: SAMPLE_HTML }));
    vi.stubGlobal('fetch', fetchMock);

    expect(sessionCacheSize()).toBe(0);

    await fetchSource({ url: 'https://example.com/cached', extractMode: 'full' });
    expect(sessionCacheSize()).toBe(1);

    // Second call should use cache, not fetch again
    await fetchSource({ url: 'https://example.com/cached', extractMode: 'full' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // Only one network call
  });

  it('serves cached content with fresh excerpts for different queries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse({ body: SAMPLE_HTML })));

    const r1 = await fetchSource({
      url: 'https://example.com/multi-query',
      extractMode: 'relevant',
      query: 'AI safety funding',
    });

    const r2 = await fetchSource({
      url: 'https://example.com/multi-query',
      extractMode: 'relevant',
      query: 'Open Philanthropy',
    });

    // Both should succeed from cache, with different excerpts
    expect(r1.status).toBe('ok');
    expect(r2.status).toBe('ok');
    // Content is shared from cache
    expect(r1.content).toBe(r2.content);
  });

  it('returns empty excerpts for extractMode=full even when cache has relevant excerpts (C2 regression)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse({ body: SAMPLE_HTML })));
    const url = 'https://example.com/cache-bug-regression';

    // First fetch: relevant mode populates cache with excerpts
    const r1 = await fetchSource({ url, extractMode: 'relevant', query: 'AI safety funding' });
    expect(r1.relevantExcerpts.length).toBeGreaterThan(0);

    // Second fetch: full mode should return EMPTY excerpts, not r1's cached excerpts
    const r2 = await fetchSource({ url, extractMode: 'full' });
    expect(r2.relevantExcerpts).toEqual([]);
    // Content should be the same (from cache)
    expect(r2.content).toBe(r1.content);
  });

  it('returns error for unverifiable social media URLs', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSource({ url: 'https://twitter.com/user/status/123', extractMode: 'full' });

    expect(result.status).toBe('error');
    expect(fetchMock).not.toHaveBeenCalled(); // Should not attempt network fetch
  });

  it('returns error status for PDF content types', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse({
      contentType: 'application/pdf',
    })));

    const result = await fetchSource({ url: 'https://example.com/paper.pdf', extractMode: 'full' });

    expect(result.status).toBe('error');
    expect(result.content).toBe('');
  });

  it('returns error for non-HTML, non-PDF content types', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse({
      contentType: 'application/json',
      body: '{"key": "value"}',
    })));

    const result = await fetchSource({ url: 'https://api.example.com/data.json', extractMode: 'full' });

    expect(result.status).toBe('error');
    expect(result.content).toBe('');
  });

  it('serves from SQLite cache when session cache is empty', async () => {
    const { citationContent } = await import('./knowledge-db.ts');
    const getByUrlMock = citationContent.getByUrl as ReturnType<typeof vi.fn>;
    const upsertMock = citationContent.upsert as ReturnType<typeof vi.fn>;
    // Clear accumulated call counts from earlier tests in this describe block
    getByUrlMock.mockClear();
    upsertMock.mockClear();

    // Simulate a SQLite cache hit (recent enough to be within TTL)
    getByUrlMock.mockReturnValueOnce({
      full_text: 'Cached content about AI safety from SQLite.',
      page_title: 'Cached Title',
      fetched_at: new Date().toISOString(),
    });

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSource({ url: 'https://example.com/sqlite-cached', extractMode: 'full' });

    expect(result.status).toBe('ok');
    expect(result.title).toBe('Cached Title');
    expect(result.content).toBe('Cached content about AI safety from SQLite.');
    expect(fetchMock).not.toHaveBeenCalled(); // Should not network-fetch
    expect(upsertMock).not.toHaveBeenCalled(); // Should not re-save
  });

  it('skips stale SQLite cache entries past TTL (#676)', async () => {
    const { citationContent } = await import('./knowledge-db.ts');
    const getByUrlMock = citationContent.getByUrl as ReturnType<typeof vi.fn>;
    clearSessionCache();

    // Return a cache entry from 2 months ago — past the 7-day TTL
    getByUrlMock.mockReturnValueOnce({
      full_text: 'Stale content from months ago.',
      page_title: 'Old Title',
      fetched_at: '2024-01-01T00:00:00.000Z',
    });

    // The fetch should happen since cache is stale
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response('<html><head><title>Fresh</title></head><body>Fresh content about AI safety that has been recently updated.</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSource({ url: 'https://example.com/stale-cached', extractMode: 'full' });

    expect(result.status).toBe('ok');
    expect(fetchMock).toHaveBeenCalled(); // Should network-fetch since cache is stale
  });
});

// ---------------------------------------------------------------------------
// fetchSources — batch function
// ---------------------------------------------------------------------------

describe('fetchSources', () => {
  beforeEach(() => {
    clearSessionCache();
    vi.restoreAllMocks();
  });

  it('fetches multiple URLs in order', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve(makeFetchResponse({
        body: `<html><head><title>Page ${callCount}</title></head><body><p>Content ${callCount}</p></body></html>`,
      }));
    }));

    const requests: FetchRequest[] = [
      { url: 'https://example.com/1', extractMode: 'full' },
      { url: 'https://example.com/2', extractMode: 'full' },
      { url: 'https://example.com/3', extractMode: 'full' },
    ];

    const results = await fetchSources(requests, { delayMs: 0 });

    expect(results).toHaveLength(3);
    expect(results[0].url).toBe('https://example.com/1');
    expect(results[1].url).toBe('https://example.com/2');
    expect(results[2].url).toBe('https://example.com/3');
  });

  it('handles mixed success and failure gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('dead')) {
        return Promise.resolve(makeFetchResponse({ status: 404 }));
      }
      return Promise.resolve(makeFetchResponse({ body: SAMPLE_HTML }));
    }));

    const results = await fetchSources([
      { url: 'https://example.com/ok', extractMode: 'full' },
      { url: 'https://example.com/dead', extractMode: 'full' },
    ], { delayMs: 0 });

    expect(results[0].status).toBe('ok');
    expect(results[1].status).toBe('dead');
  });

  it('returns empty array for empty input', async () => {
    const results = await fetchSources([]);
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetchAndVerifyClaim — integration helper
// ---------------------------------------------------------------------------

describe('fetchAndVerifyClaim', () => {
  beforeEach(() => {
    clearSessionCache();
    vi.restoreAllMocks();
  });

  it('returns hasSupport=true when relevant excerpts found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse({
      body: SAMPLE_HTML,
    })));

    const { source, hasSupport } = await fetchAndVerifyClaim(
      'https://example.com/funding',
      'AI safety funding reached $100 million in 2023',
    );

    expect(source.status).toBe('ok');
    expect(hasSupport).toBe(true);
  });

  it('returns hasSupport=false for dead links', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse({ status: 404 })));

    const { source, hasSupport } = await fetchAndVerifyClaim(
      'https://example.com/gone',
      'AI safety funding',
    );

    expect(source.status).toBe('dead');
    expect(hasSupport).toBe(false);
  });

  it('returns hasSupport=false when no relevant content found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse({
      body: '<html><head><title>Unrelated</title></head><body><p>Quantum computing hardware designs from 2024.</p></body></html>',
    })));

    const { hasSupport } = await fetchAndVerifyClaim(
      'https://example.com/unrelated',
      'AI safety funding 100 million researchers',
    );

    expect(hasSupport).toBe(false);
  });

  it('returns hasSupport=false for paywall responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse({
      body: PAYWALL_HTML,
    })));

    const { source, hasSupport } = await fetchAndVerifyClaim(
      'https://newspaper.com/paywalled',
      'AI safety funding',
    );

    expect(source.status).toBe('paywall');
    expect(hasSupport).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// clearSessionCache
// ---------------------------------------------------------------------------

describe('clearSessionCache', () => {
  beforeEach(() => {
    clearSessionCache();
    vi.restoreAllMocks();
  });

  it('empties the in-memory cache', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse({ body: SAMPLE_HTML })));

    await fetchSource({ url: 'https://example.com/cache-test', extractMode: 'full' });
    expect(sessionCacheSize()).toBe(1);

    clearSessionCache();
    expect(sessionCacheSize()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Resource integration
// ---------------------------------------------------------------------------

describe('resource integration', () => {
  beforeEach(() => {
    clearSessionCache();
    vi.restoreAllMocks();
  });

  it('attaches resource metadata when URL matches a known resource', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse({ body: SAMPLE_HTML })));

    const result = await fetchSource({
      url: 'https://example.com/safety-paper',
      extractMode: 'full',
    });

    expect(result.resource).toBeDefined();
    expect(result.resource!.id).toBe('res-safety-paper');
    expect(result.resource!.title).toBe('AI Safety Research Paper');
    expect(result.resource!.type).toBe('paper');
    expect(result.resource!.summary).toBe('A paper about AI safety techniques');
    expect(result.resource!.authors).toEqual(['Jane Smith']);
    expect(result.resource!.tags).toEqual(['safety', 'alignment']);
  });

  it('returns undefined resource when URL does not match', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse({ body: SAMPLE_HTML })));

    const result = await fetchSource({
      url: 'https://unknown.com/page',
      extractMode: 'full',
    });

    expect(result.resource).toBeUndefined();
  });

  it('resolves URL from resourceId when URL is omitted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse({ body: SAMPLE_HTML })));

    const result = await fetchSource({
      resourceId: 'res-safety-paper',
      extractMode: 'full',
    });

    expect(result.url).toBe('https://example.com/safety-paper');
    expect(result.resource).toBeDefined();
    expect(result.resource!.id).toBe('res-safety-paper');
    expect(result.status).toBe('ok');
  });

  it('uses resource title as fallback when fetched page has no title', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse({
      body: '<html><body><p>Content without a title tag.</p></body></html>',
    })));

    const result = await fetchSource({
      resourceId: 'res-blog-post',
      extractMode: 'full',
    });

    expect(result.title).toBe('Alignment Blog Post');
  });

  it('prefers fetched title over resource title when both exist', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse({
      body: '<html><head><title>Fetched Title</title></head><body><p>Content.</p></body></html>',
    })));

    const result = await fetchSource({
      resourceId: 'res-blog-post',
      extractMode: 'full',
    });

    expect(result.title).toBe('Fetched Title');
  });

  it('calls updateResourceFetchStatus when updateResourceStatus is true', async () => {
    const { updateResourceFetchStatus } = await import('./resource-lookup.ts');
    const updateMock = updateResourceFetchStatus as ReturnType<typeof vi.fn>;
    updateMock.mockClear();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse({ body: SAMPLE_HTML })));

    await fetchSource({
      url: 'https://example.com/safety-paper',
      extractMode: 'full',
      updateResourceStatus: true,
    });

    expect(updateMock).toHaveBeenCalledOnce();
    expect(updateMock).toHaveBeenCalledWith('res-safety-paper', expect.objectContaining({
      fetchStatus: 'ok',
      fetchedAt: expect.any(String),
    }));
  });

  it('does not call updateResourceFetchStatus when updateResourceStatus is false', async () => {
    const { updateResourceFetchStatus } = await import('./resource-lookup.ts');
    const updateMock = updateResourceFetchStatus as ReturnType<typeof vi.fn>;
    updateMock.mockClear();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse({ body: SAMPLE_HTML })));

    await fetchSource({
      url: 'https://example.com/safety-paper',
      extractMode: 'full',
    });

    expect(updateMock).not.toHaveBeenCalled();
  });

  it('reflects dead status back to resource when updateResourceStatus is true', async () => {
    const { updateResourceFetchStatus } = await import('./resource-lookup.ts');
    const updateMock = updateResourceFetchStatus as ReturnType<typeof vi.fn>;
    updateMock.mockClear();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse({ status: 404 })));

    await fetchSource({
      url: 'https://example.com/safety-paper',
      extractMode: 'full',
      updateResourceStatus: true,
    });

    expect(updateMock).toHaveBeenCalledWith('res-safety-paper', expect.objectContaining({
      fetchStatus: 'dead',
    }));
  });

  it('throws when neither url nor valid resourceId is provided', async () => {
    await expect(fetchSource({
      extractMode: 'full',
    })).rejects.toThrow('FetchRequest requires either url or a valid resourceId');
  });
});

// ---------------------------------------------------------------------------
// requestsFromResourceIds
// ---------------------------------------------------------------------------

describe('requestsFromResourceIds', () => {
  it('builds FetchRequests from known resource IDs', () => {
    const requests = requestsFromResourceIds(['res-safety-paper', 'res-blog-post']);
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe('https://example.com/safety-paper');
    expect(requests[0].resourceId).toBe('res-safety-paper');
    expect(requests[1].url).toBe('https://example.com/blog');
    expect(requests[1].resourceId).toBe('res-blog-post');
  });

  it('skips unknown resource IDs', () => {
    const requests = requestsFromResourceIds(['res-safety-paper', 'nonexistent', 'res-blog-post']);
    expect(requests).toHaveLength(2);
  });

  it('passes through options', () => {
    const requests = requestsFromResourceIds(['res-safety-paper'], {
      extractMode: 'relevant',
      query: 'AI safety',
      updateResourceStatus: true,
    });
    expect(requests[0].extractMode).toBe('relevant');
    expect(requests[0].query).toBe('AI safety');
    expect(requests[0].updateResourceStatus).toBe(true);
  });

  it('returns empty array for empty input', () => {
    expect(requestsFromResourceIds([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// In-flight deduplication (#650)
// ---------------------------------------------------------------------------

describe('in-flight deduplication', () => {
  beforeEach(() => {
    clearSessionCache();
    vi.restoreAllMocks();
  });

  it('makes only one network fetch when fetchSources has duplicate URLs', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve(makeFetchResponse({ body: SAMPLE_HTML }));
    }));

    const results = await fetchSources([
      { url: 'https://example.com/same', extractMode: 'full' },
      { url: 'https://example.com/same', extractMode: 'full' },
      { url: 'https://example.com/same', extractMode: 'full' },
    ], { delayMs: 0, concurrency: 10 });

    expect(results).toHaveLength(3);
    // All results should be ok
    expect(results.every(r => r.status === 'ok')).toBe(true);
    // Only one network fetch should have been made (in-flight dedup + session cache)
    expect(callCount).toBe(1);
  });

  it('concurrent fetchSource calls for same URL result in single network fetch', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      callCount++;
      return new Promise(resolve =>
        setTimeout(() => resolve(makeFetchResponse({ body: SAMPLE_HTML })), 10)
      );
    }));

    // Fire 3 fetches concurrently (same URL)
    const [r1, r2, r3] = await Promise.all([
      fetchSource({ url: 'https://example.com/concurrent', extractMode: 'full' }),
      fetchSource({ url: 'https://example.com/concurrent', extractMode: 'relevant', query: 'AI safety' }),
      fetchSource({ url: 'https://example.com/concurrent', extractMode: 'full' }),
    ]);

    expect(r1.status).toBe('ok');
    expect(r2.status).toBe('ok');
    expect(r3.status).toBe('ok');
    // Only one actual network call
    expect(callCount).toBe(1);
    // The relevant-mode call should still have excerpts
    expect(r2.relevantExcerpts.length).toBeGreaterThanOrEqual(0);
  });

  it('clears in-flight map after fetch completes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse({ body: SAMPLE_HTML })));

    await fetchSource({ url: 'https://example.com/cleared', extractMode: 'full' });

    // Second call should use session cache, not in-flight
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve(makeFetchResponse({ body: SAMPLE_HTML }));
    }));

    await fetchSource({ url: 'https://example.com/cleared', extractMode: 'full' });
    expect(callCount).toBe(0); // Served from session cache
  });
});

// ---------------------------------------------------------------------------
// LRU cache eviction (#650)
// ---------------------------------------------------------------------------

describe('LRU cache eviction', () => {
  beforeEach(() => {
    clearSessionCache();
    vi.restoreAllMocks();
  });

  it('evicts oldest entries when cache exceeds 500', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() =>
      Promise.resolve(makeFetchResponse({ body: '<html><body><p>Content</p></body></html>' }))
    ));

    // Fill cache with 502 unique URLs
    for (let i = 0; i < 502; i++) {
      await fetchSource({ url: `https://example.com/page-${i}`, extractMode: 'full' });
    }

    // Cache should be capped at 500
    expect(sessionCacheSize()).toBe(500);
    // At least 2 evictions
    expect(sessionCacheEvictions()).toBeGreaterThanOrEqual(2);
  });

  it('sessionCacheEvictions returns 0 after cache clear', () => {
    expect(sessionCacheEvictions()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PostgreSQL write path (#647)
// ---------------------------------------------------------------------------

describe('PostgreSQL write path', () => {
  beforeEach(async () => {
    clearSessionCache();
    vi.restoreAllMocks();
    // Reset wiki-server mock to default (server unavailable)
    const { upsertCitationContent, getCitationContentByUrl } = await import('./wiki-server/citations.ts');
    (upsertCitationContent as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: { url: 'https://example.com' } });
    (getCitationContentByUrl as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: 'unavailable', message: 'no server' });
  });

  it('calls upsertCitationContent after a successful network fetch', async () => {
    const { upsertCitationContent } = await import('./wiki-server/citations.ts');
    const upsertMock = upsertCitationContent as ReturnType<typeof vi.fn>;
    upsertMock.mockClear();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse({ body: SAMPLE_HTML })));

    const result = await fetchSource({ url: 'https://example.com/pg-write-test', extractMode: 'full' });

    expect(result.status).toBe('ok');
    // Allow the fire-and-forget promise to settle
    await new Promise(r => setTimeout(r, 10));
    expect(upsertMock).toHaveBeenCalledOnce();
    expect(upsertMock).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://example.com/pg-write-test',
      fullText: expect.any(String),
      httpStatus: 200,
    }));
  });

  it('does not call upsertCitationContent when content is empty (e.g. dead link)', async () => {
    const { upsertCitationContent } = await import('./wiki-server/citations.ts');
    const upsertMock = upsertCitationContent as ReturnType<typeof vi.fn>;
    upsertMock.mockClear();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse({ status: 404 })));

    const result = await fetchSource({ url: 'https://example.com/dead-pg', extractMode: 'full' });

    expect(result.status).toBe('dead');
    await new Promise(r => setTimeout(r, 10));
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('serves from PostgreSQL cache when session cache is empty', async () => {
    const { getCitationContentByUrl } = await import('./wiki-server/citations.ts');
    const getMock = getCitationContentByUrl as ReturnType<typeof vi.fn>;
    getMock.mockResolvedValueOnce({
      ok: true,
      data: {
        url: 'https://example.com/pg-cached',
        pageTitle: 'PG Cached Page',
        fullText: 'Content stored in PostgreSQL about AI safety.',
        fetchedAt: '2025-01-01T00:00:00.000Z',
        httpStatus: 200,
        contentType: 'text/html',
        fullTextPreview: null,
        contentLength: 44,
        contentHash: null,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    });

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSource({ url: 'https://example.com/pg-cached', extractMode: 'full' });

    expect(result.status).toBe('ok');
    expect(result.title).toBe('PG Cached Page');
    expect(result.content).toBe('Content stored in PostgreSQL about AI safety.');
    expect(fetchMock).not.toHaveBeenCalled(); // No network call needed
  });

  it('extracts relevant excerpts from PostgreSQL-cached content', async () => {
    const { getCitationContentByUrl } = await import('./wiki-server/citations.ts');
    const getMock = getCitationContentByUrl as ReturnType<typeof vi.fn>;
    getMock.mockResolvedValueOnce({
      ok: true,
      data: {
        url: 'https://example.com/pg-relevant',
        pageTitle: 'AI Safety Report',
        fullText: 'Global spending on AI safety research reached $100 million.\n\nResearchers worldwide have increased commitments to AI alignment.\n\nUnrelated paragraph about climate science.',
        fetchedAt: '2025-01-01T00:00:00.000Z',
        httpStatus: 200,
        contentType: 'text/html',
        fullTextPreview: null,
        contentLength: 100,
        contentHash: null,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    });

    vi.stubGlobal('fetch', vi.fn());

    const result = await fetchSource({
      url: 'https://example.com/pg-relevant',
      extractMode: 'relevant',
      query: 'AI safety funding',
    });

    expect(result.status).toBe('ok');
    expect(result.relevantExcerpts.length).toBeGreaterThan(0);
    expect(result.relevantExcerpts.some(e => e.includes('100 million') || e.includes('alignment'))).toBe(true);
  });

  it('falls back to SQLite when PostgreSQL returns unavailable', async () => {
    const { getCitationContentByUrl } = await import('./wiki-server/citations.ts');
    const getMock = getCitationContentByUrl as ReturnType<typeof vi.fn>;
    // PostgreSQL says unavailable
    getMock.mockResolvedValueOnce({ ok: false, error: 'unavailable', message: 'no server' });

    const { citationContent } = await import('./knowledge-db.ts');
    const getByUrlMock = citationContent.getByUrl as ReturnType<typeof vi.fn>;
    getByUrlMock.mockReturnValueOnce({
      full_text: 'Content from SQLite fallback.',
      page_title: 'SQLite Title',
      fetched_at: '2025-01-01T00:00:00.000Z',
    });

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSource({ url: 'https://example.com/sqlite-fallback', extractMode: 'full' });

    expect(result.status).toBe('ok');
    expect(result.content).toBe('Content from SQLite fallback.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('backfills SQLite when served from PostgreSQL cache', async () => {
    const { getCitationContentByUrl } = await import('./wiki-server/citations.ts');
    const getMock = getCitationContentByUrl as ReturnType<typeof vi.fn>;
    getMock.mockResolvedValueOnce({
      ok: true,
      data: {
        url: 'https://example.com/backfill-test',
        pageTitle: 'Backfill Test',
        fullText: 'PostgreSQL content for backfill test.',
        fetchedAt: '2025-01-01T00:00:00.000Z',
        httpStatus: 200,
        contentType: 'text/html',
        fullTextPreview: null,
        contentLength: 37,
        contentHash: null,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    });

    const { citationContent } = await import('./knowledge-db.ts');
    const upsertSqliteMock = citationContent.upsert as ReturnType<typeof vi.fn>;
    upsertSqliteMock.mockClear();

    vi.stubGlobal('fetch', vi.fn());

    await fetchSource({ url: 'https://example.com/backfill-test', extractMode: 'full' });

    // SQLite should be backfilled from PostgreSQL
    expect(upsertSqliteMock).toHaveBeenCalledOnce();
    expect(upsertSqliteMock).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://example.com/backfill-test',
      fullText: 'PostgreSQL content for backfill test.',
    }));
  });
});
