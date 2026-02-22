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
  clearSessionCache,
  sessionCacheSize,
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

  it('returns dead status for non-HTML content types (PDF)', async () => {
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

    // Simulate a SQLite cache hit
    getByUrlMock.mockReturnValueOnce({
      full_text: 'Cached content about AI safety from SQLite.',
      page_title: 'Cached Title',
      fetched_at: '2024-01-01T00:00:00.000Z',
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
