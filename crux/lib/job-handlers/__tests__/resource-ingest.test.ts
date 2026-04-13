/**
 * Tests for resource-ingest job handler.
 *
 * Covers:
 *  - Successful ingestion via shared source-fetcher
 *  - Content hash computation and change detection
 *  - Soft-404 detection on fetched content
 *  - Dead/error/paywall status mapping from fetchSource
 *  - SSRF protection (private hosts)
 *  - Invalid/non-HTTPS URLs
 *  - Param validation
 *  - fetch_status persistence
 *  - Enrichment chaining
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import type { JobHandlerContext } from '../types.ts';
import type { FetchedSource, FetchedSourceStatus } from '../../search/source-fetcher.ts';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../sourcing/source-fetcher.ts', () => ({
  isPrivateHost: (host: string) =>
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host),
}));

const mockFetchSource = vi.fn<(req: unknown) => Promise<FetchedSource>>();

vi.mock('../../search/source-fetcher.ts', () => ({
  fetchSource: (req: unknown) => mockFetchSource(req),
}));

const mockFindResourcesByContentHash = vi.fn();

vi.mock('../../wiki-server/resources.ts', () => ({
  updateResourceFetchStatus: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  lookupResourceByUrl: vi.fn().mockResolvedValue({ ok: false }),
  findResourcesByContentHash: (...args: unknown[]) => mockFindResourcesByContentHash(...args),
}));

const mockCreateJob = vi.fn<() => Promise<{ ok: boolean; data: Record<string, unknown> }>>();

vi.mock('../../wiki-server/jobs.ts', () => ({
  createJob: (...args: unknown[]) => mockCreateJob(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CTX: JobHandlerContext = {
  workerId: 'test-worker',
  projectRoot: '/tmp/test',
  verbose: false,
};

function expectedHash(text: string): string {
  return createHash('sha256')
    .update(text.slice(0, 1_000_000))
    .digest('hex')
    .slice(0, 16);
}

/** Build a mock FetchedSource result. */
function mockFetchResult(overrides: Partial<FetchedSource> = {}): FetchedSource {
  return {
    url: 'https://example.com/page',
    title: 'Test Page',
    fetchedAt: new Date().toISOString(),
    content: 'This is the content of the page about AI safety.',
    relevantExcerpts: [],
    status: 'ok' as FetchedSourceStatus,
    httpStatus: 200,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.restoreAllMocks();
  mockFetchSource.mockClear();
  mockCreateJob.mockClear();
  mockCreateJob.mockResolvedValue({ ok: true, data: { id: 999 } });
  mockFetchSource.mockResolvedValue(mockFetchResult());
  mockFindResourcesByContentHash.mockClear();
  mockFindResourcesByContentHash.mockResolvedValue({ ok: true, data: { resources: [] } });
});

// ---------------------------------------------------------------------------
// Import handler (after mocks are set up)
// ---------------------------------------------------------------------------

const { handleResourceIngest } = await import('../resource-ingest.ts');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleResourceIngest — param validation', () => {
  it('rejects missing resourceId', async () => {
    const result = await handleResourceIngest({ url: 'https://example.com' }, CTX);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid params');
  });

  it('rejects missing url', async () => {
    const result = await handleResourceIngest({ resourceId: 'res-1' }, CTX);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid params');
  });

  it('rejects invalid url format', async () => {
    const result = await handleResourceIngest({ resourceId: 'res-1', url: 'not-a-url' }, CTX);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid params');
  });
});

describe('handleResourceIngest — URL security', () => {
  it('rejects non-HTTPS URLs', async () => {
    const result = await handleResourceIngest(
      { resourceId: 'res-1', url: 'http://example.com/page' },
      CTX,
    );
    expect(result.success).toBe(true);
    expect(result.data.status).toBe('invalid_url');
  });

  it('blocks private hosts (SSRF protection)', async () => {
    const result = await handleResourceIngest(
      { resourceId: 'res-1', url: 'https://localhost/admin' },
      CTX,
    );
    expect(result.success).toBe(true);
    expect(result.data.status).toBe('blocked');
  });

  it('blocks 10.x.x.x range', async () => {
    const result = await handleResourceIngest(
      { resourceId: 'res-1', url: 'https://10.0.0.1/internal' },
      CTX,
    );
    expect(result.success).toBe(true);
    expect(result.data.status).toBe('blocked');
  });
});

describe('handleResourceIngest — successful ingestion', () => {
  it('returns reachable with content hash for OK response', async () => {
    const content = 'Article about AI safety research.';
    mockFetchSource.mockResolvedValue(mockFetchResult({ content }));

    const result = await handleResourceIngest(
      { resourceId: 'res-1', url: 'https://example.com/article' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('reachable');
    expect(result.data.contentHash).toBe(expectedHash(content));
    expect(result.data.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('calls fetchSource with correct params', async () => {
    await handleResourceIngest(
      { resourceId: 'res-1', url: 'https://example.com/article' },
      CTX,
    );

    expect(mockFetchSource).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.com/article',
        extractMode: 'full',
        resourceId: 'res-1',
        maxAgeMs: 0,
      }),
    );
  });

  it('detects content change via previousContentHash', async () => {
    const content = 'Updated content';
    mockFetchSource.mockResolvedValue(mockFetchResult({ content }));

    const result = await handleResourceIngest(
      {
        resourceId: 'res-1',
        url: 'https://example.com/page',
        previousContentHash: 'aaaaaaaaaaaaaaaa',
      },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.contentChanged).toBe(true);
  });

  it('reports no change when hash matches', async () => {
    const content = 'Same content';
    mockFetchSource.mockResolvedValue(mockFetchResult({ content }));

    const result = await handleResourceIngest(
      {
        resourceId: 'res-1',
        url: 'https://example.com/page',
        previousContentHash: expectedHash(content),
      },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.contentChanged).toBe(false);
  });
});

describe('handleResourceIngest — status mapping', () => {
  it('maps dead + 404 to not_found', async () => {
    mockFetchSource.mockResolvedValue(mockFetchResult({
      status: 'dead' as FetchedSourceStatus,
      httpStatus: 404,
      content: '',
    }));

    const result = await handleResourceIngest(
      { resourceId: 'res-1', url: 'https://example.com/gone' },
      CTX,
    );

    expect(result.data.status).toBe('not_found');
  });

  it('maps dead + 0 to unreachable', async () => {
    mockFetchSource.mockResolvedValue(mockFetchResult({
      status: 'dead' as FetchedSourceStatus,
      httpStatus: 0,
      content: '',
    }));

    const result = await handleResourceIngest(
      { resourceId: 'res-1', url: 'https://example.com/down' },
      CTX,
    );

    expect(result.data.status).toBe('unreachable');
  });

  it('maps paywall status', async () => {
    mockFetchSource.mockResolvedValue(mockFetchResult({
      status: 'paywall' as FetchedSourceStatus,
      httpStatus: 200,
      content: 'Subscribe to continue',
    }));

    const result = await handleResourceIngest(
      { resourceId: 'res-1', url: 'https://example.com/paywalled' },
      CTX,
    );

    expect(result.data.status).toBe('paywall');
  });

  it('maps error + 0 to timeout', async () => {
    mockFetchSource.mockResolvedValue(mockFetchResult({
      status: 'error' as FetchedSourceStatus,
      httpStatus: 0,
      content: '',
    }));

    const result = await handleResourceIngest(
      { resourceId: 'res-1', url: 'https://example.com/timeout' },
      CTX,
    );

    expect(result.data.status).toBe('timeout');
  });
});

describe('handleResourceIngest — soft-404 detection', () => {
  it('detects soft 404 in short pages', async () => {
    mockFetchSource.mockResolvedValue(mockFetchResult({
      content: 'Page not found. The page you requested does not exist.',
    }));

    const result = await handleResourceIngest(
      { resourceId: 'res-1', url: 'https://example.com/missing' },
      CTX,
    );

    expect(result.data.status).toBe('soft_404');
  });

  it('does not flag long pages as soft 404', async () => {
    const longContent = 'Page not found mentioned in passing. ' + 'A'.repeat(6000);
    mockFetchSource.mockResolvedValue(mockFetchResult({ content: longContent }));

    const result = await handleResourceIngest(
      { resourceId: 'res-1', url: 'https://example.com/real' },
      CTX,
    );

    expect(result.data.status).toBe('reachable');
  });
});

describe('handleResourceIngest — fetch_status persistence', () => {
  it('persists ok for reachable', async () => {
    const { updateResourceFetchStatus } = await import('../../wiki-server/resources.ts');

    await handleResourceIngest(
      { resourceId: 'res-1', url: 'https://example.com/article' },
      CTX,
    );

    expect(updateResourceFetchStatus).toHaveBeenCalledWith(
      'res-1',
      expect.objectContaining({ fetchStatus: 'ok' }),
    );
  });

  it('persists not_found for 404', async () => {
    const { updateResourceFetchStatus } = await import('../../wiki-server/resources.ts');

    mockFetchSource.mockResolvedValue(mockFetchResult({
      status: 'dead' as FetchedSourceStatus,
      httpStatus: 404,
      content: '',
    }));

    await handleResourceIngest(
      { resourceId: 'res-1', url: 'https://example.com/gone' },
      CTX,
    );

    expect(updateResourceFetchStatus).toHaveBeenCalledWith(
      'res-1',
      expect.objectContaining({ fetchStatus: 'not_found' }),
    );
  });
});

describe('handleResourceIngest — enrichment chaining', () => {
  it('enqueues resource-enrich for reachable resources', async () => {
    await handleResourceIngest(
      { resourceId: 'res-1', url: 'https://example.com/article' },
      CTX,
    );

    expect(mockCreateJob).toHaveBeenCalledWith(expect.objectContaining({
      type: 'resource-enrich',
      params: { resourceId: 'res-1', url: 'https://example.com/article' },
    }));
  });

  it('does NOT enqueue enrichment for dead resources', async () => {
    mockFetchSource.mockResolvedValue(mockFetchResult({
      status: 'dead' as FetchedSourceStatus,
      httpStatus: 404,
      content: '',
    }));

    await handleResourceIngest(
      { resourceId: 'res-1', url: 'https://example.com/gone' },
      CTX,
    );

    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it('still succeeds when enrichment enqueue fails', async () => {
    mockCreateJob.mockRejectedValue(new Error('Wiki-server down'));

    const result = await handleResourceIngest(
      { resourceId: 'res-1', url: 'https://example.com/article' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('reachable');
  });

  it('does NOT enqueue enrichment when content is empty', async () => {
    mockFetchSource.mockResolvedValue(mockFetchResult({
      status: 'ok' as FetchedSourceStatus,
      httpStatus: 200,
      content: '',
    }));

    const result = await handleResourceIngest(
      { resourceId: 'res-1', url: 'https://example.com/empty' },
      CTX,
    );

    expect(result.data.status).toBe('reachable');
    expect(result.data.contentHash).toBeNull();
    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  // QUA-312 Phase 2: contentChanged propagation into the enrich job payload
  it('passes contentChanged: true into the enrich job when content changed since last fetch', async () => {
    const content = 'Updated article content here.';
    mockFetchSource.mockResolvedValue(mockFetchResult({ content }));

    await handleResourceIngest(
      {
        resourceId: 'res-1',
        url: 'https://example.com/article',
        previousContentHash: 'aaaaaaaaaaaaaaaa', // different from new hash → contentChanged=true
      },
      CTX,
    );

    expect(mockCreateJob).toHaveBeenCalledTimes(1);
    expect(mockCreateJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'resource-enrich',
        params: {
          resourceId: 'res-1',
          url: 'https://example.com/article',
          contentChanged: true,
        },
        // dedupKey varies so a still-pending enrich doesn't suppress the new signal
        dedupKey: expect.stringMatching(/^resource-enrich:res-1:[a-f0-9]{8}$/),
      }),
    );
  });

  it('omits contentChanged from payload when content has not changed', async () => {
    const content = 'Same article content.';
    mockFetchSource.mockResolvedValue(mockFetchResult({ content }));

    await handleResourceIngest(
      {
        resourceId: 'res-1',
        url: 'https://example.com/article',
        previousContentHash: expectedHash(content), // matches → contentChanged=false
      },
      CTX,
    );

    expect(mockCreateJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'resource-enrich',
        // No contentChanged key on params when content is unchanged
        params: { resourceId: 'res-1', url: 'https://example.com/article' },
        dedupKey: 'resource-enrich:res-1',
      }),
    );
  });

  it('omits contentChanged from payload when there is no previousContentHash', async () => {
    await handleResourceIngest(
      { resourceId: 'res-1', url: 'https://example.com/article' },
      CTX,
    );

    expect(mockCreateJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'resource-enrich',
        params: { resourceId: 'res-1', url: 'https://example.com/article' },
        dedupKey: 'resource-enrich:res-1',
      }),
    );
  });
});

describe('handleResourceIngest — Twitter/X soft-404 (#3521)', () => {
  it('maps dead status from fetchSource for Twitter soft-404', async () => {
    // fetchSource now detects Twitter soft-404 internally and returns status: 'dead'
    mockFetchSource.mockResolvedValue(mockFetchResult({
      status: 'dead' as FetchedSourceStatus,
      httpStatus: 200,
      content: '',
    }));

    const result = await handleResourceIngest(
      { resourceId: 'res-1', url: 'https://twitter.com/elaboratehoax' },
      CTX,
    );

    expect(result.success).toBe(true);
    // dead + httpStatus 200 maps to 'error' via mapFetchStatus (not 404)
    // The actual soft-404 detection is in fetchSource/paywall-detection
    expect(result.data.status).toBe('error');
  });

  it('passes through reachable for real Twitter profiles', async () => {
    mockFetchSource.mockResolvedValue(mockFetchResult({
      status: 'ok' as FetchedSourceStatus,
      httpStatus: 200,
      content: 'Real profile content. '.repeat(200),
    }));

    const result = await handleResourceIngest(
      { resourceId: 'res-1', url: 'https://twitter.com/realuser' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('reachable');
  });
});

describe('handleResourceIngest — cookie consent detection (#3522)', () => {
  it('maps paywall status from fetchSource for cookie consent pages', async () => {
    // fetchSource detects cookie consent internally and returns status: 'paywall'
    mockFetchSource.mockResolvedValue(mockFetchResult({
      status: 'paywall' as FetchedSourceStatus,
      httpStatus: 200,
      content: 'This site requires cookies to function properly.',
    }));

    const result = await handleResourceIngest(
      { resourceId: 'res-1', url: 'https://nature.com/articles/123' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('paywall');
  });

  it('passes through reachable for normal redirects', async () => {
    mockFetchSource.mockResolvedValue(mockFetchResult({
      status: 'ok' as FetchedSourceStatus,
      httpStatus: 200,
      content: '<html><body><h1>Article Content</h1>' + '<p>Real content.</p>'.repeat(200) + '</body></html>',
    }));

    const result = await handleResourceIngest(
      { resourceId: 'res-1', url: 'https://nature.com/articles/123' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('reachable');
  });
});

describe('handleResourceIngest — resilience', () => {
  it('succeeds even when fetch_status persistence fails', async () => {
    const { updateResourceFetchStatus } = await import('../../wiki-server/resources.ts');
    (updateResourceFetchStatus as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('DB connection lost'),
    );

    const result = await handleResourceIngest(
      { resourceId: 'res-1', url: 'https://example.com/article' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('reachable');
  });
});

// ---------------------------------------------------------------------------
// #3520 — fetchStatus persistence for DNS failures and timeouts
// ---------------------------------------------------------------------------

describe('handleResourceIngest — fetchStatus persistence (#3520)', () => {
  it('persists fetchStatus=unreachable for DNS failure', async () => {
    const { updateResourceFetchStatus } = await import('../../wiki-server/resources.ts');

    mockFetchSource.mockResolvedValue(mockFetchResult({
      status: 'dead' as FetchedSourceStatus,
      httpStatus: 0,
      content: '',
    }));

    const result = await handleResourceIngest(
      { resourceId: 'res-dns', url: 'https://nonexistent.example.com' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('unreachable');
    expect(updateResourceFetchStatus).toHaveBeenCalledWith(
      'res-dns',
      expect.objectContaining({ fetchStatus: 'unreachable' }),
    );
  });

  it('persists fetchStatus=timeout for timeouts', async () => {
    const { updateResourceFetchStatus } = await import('../../wiki-server/resources.ts');

    mockFetchSource.mockResolvedValue(mockFetchResult({
      status: 'error' as FetchedSourceStatus,
      httpStatus: 0,
      content: '',
    }));

    const result = await handleResourceIngest(
      { resourceId: 'res-timeout', url: 'https://slow.example.com/page' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('timeout');
    expect(updateResourceFetchStatus).toHaveBeenCalledWith(
      'res-timeout',
      expect.objectContaining({ fetchStatus: 'timeout' }),
    );
  });

  it('persists fetchStatus=error for invalid URLs', async () => {
    const { updateResourceFetchStatus } = await import('../../wiki-server/resources.ts');

    const result = await handleResourceIngest(
      { resourceId: 'res-invalid', url: 'http://example.com/page' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('invalid_url');
    expect(updateResourceFetchStatus).toHaveBeenCalledWith(
      'res-invalid',
      expect.objectContaining({ fetchStatus: 'error' }),
    );
  });

  it('persists fetchStatus=error for SSRF-blocked hosts', async () => {
    const { updateResourceFetchStatus } = await import('../../wiki-server/resources.ts');

    const result = await handleResourceIngest(
      { resourceId: 'res-ssrf', url: 'https://localhost/admin' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('blocked');
    expect(updateResourceFetchStatus).toHaveBeenCalledWith(
      'res-ssrf',
      expect.objectContaining({ fetchStatus: 'error' }),
    );
  });

  it('persists fetchStatus=ok for reachable pages', async () => {
    const { updateResourceFetchStatus } = await import('../../wiki-server/resources.ts');

    const result = await handleResourceIngest(
      { resourceId: 'res-ok', url: 'https://example.com/article' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('reachable');
    expect(updateResourceFetchStatus).toHaveBeenCalledWith(
      'res-ok',
      expect.objectContaining({ fetchStatus: 'ok' }),
    );
  });
});

// ---------------------------------------------------------------------------
// #3521 — Twitter/X soft-404 detection
// ---------------------------------------------------------------------------

describe('handleResourceIngest — Twitter soft-404 detection (#3521)', () => {
  it('detects nonexistent Twitter profile (short page, no og:description)', async () => {
    const body = '<html><head><meta charset="utf-8"><title>X</title></head><body><!-- empty --></body></html>';
    mockFetchSource.mockResolvedValue(mockFetchResult({
      content: body,
      url: 'https://x.com/elaboratehoax',
    }));

    const result = await handleResourceIngest(
      { resourceId: 'res-tw', url: 'https://twitter.com/elaboratehoax' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('soft_404');
  });

  it('does NOT flag real Twitter profile (has og:description)', async () => {
    const body = '<html><head><meta property="og:description" content="AI researcher at DeepMind"></head><body>profile content</body></html>';
    mockFetchSource.mockResolvedValue(mockFetchResult({
      content: body,
      url: 'https://x.com/realuser',
    }));

    const result = await handleResourceIngest(
      { resourceId: 'res-tw2', url: 'https://twitter.com/realuser' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('reachable');
  });

  it('does NOT flag long Twitter page as soft-404', async () => {
    const body = 'x'.repeat(2000);
    mockFetchSource.mockResolvedValue(mockFetchResult({
      content: body,
      url: 'https://x.com/someuser',
    }));

    const result = await handleResourceIngest(
      { resourceId: 'res-tw3', url: 'https://twitter.com/someuser' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('reachable');
  });

  it('does NOT flag non-Twitter short pages as Twitter soft-404', async () => {
    const body = '<html><head><title>Short Page</title></head><body>Hi</body></html>';
    mockFetchSource.mockResolvedValue(mockFetchResult({
      content: body,
      url: 'https://example.com/short',
    }));

    const result = await handleResourceIngest(
      { resourceId: 'res-other', url: 'https://example.com/short' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('reachable');
  });
});

// ---------------------------------------------------------------------------
// #3522 — Cookie consent redirect detection
// ---------------------------------------------------------------------------

describe('handleResourceIngest — cookie consent detection (#3522)', () => {
  it('detects cookie consent page via URL pattern (?error=cookies)', async () => {
    const { updateResourceFetchStatus } = await import('../../wiki-server/resources.ts');
    const body = '<html><body>Cookie settings page</body></html>';
    mockFetchSource.mockResolvedValue(mockFetchResult({
      content: body,
      url: 'https://nature.com/articles/d41586?error=cookies_not_supported&code=abc',
    }));

    const result = await handleResourceIngest(
      { resourceId: 'res-cookie1', url: 'https://nature.com/articles/d41586' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('cookie_blocked');
    expect(updateResourceFetchStatus).toHaveBeenCalledWith(
      'res-cookie1',
      expect.objectContaining({ fetchStatus: 'error' }),
    );
  });

  it('detects cookie consent page via content pattern', async () => {
    const body = '<html><body><h1>This site requires cookies</h1><p>Please enable cookies to continue.</p></body></html>';
    mockFetchSource.mockResolvedValue(mockFetchResult({ content: body }));

    const result = await handleResourceIngest(
      { resourceId: 'res-cookie2', url: 'https://example.com/article' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('cookie_blocked');
  });

  it('detects "we use cookies" consent wall on short page', async () => {
    const body = '<div class="cookie-banner">We use cookies to improve your experience. Accept all cookies?</div>';
    mockFetchSource.mockResolvedValue(mockFetchResult({ content: body }));

    const result = await handleResourceIngest(
      { resourceId: 'res-cookie3', url: 'https://example.com/page' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('cookie_blocked');
  });

  it('does NOT flag long articles mentioning cookies', async () => {
    const body = 'x'.repeat(11000) + ' we use cookies to improve your experience';
    mockFetchSource.mockResolvedValue(mockFetchResult({ content: body }));

    const result = await handleResourceIngest(
      { resourceId: 'res-long', url: 'https://example.com/real-article' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('reachable');
  });

  it('detects cookie-consent URL redirect', async () => {
    const body = '<html><body>Consent required</body></html>';
    mockFetchSource.mockResolvedValue(mockFetchResult({
      content: body,
      url: 'https://example.com/cookie-consent?return=/article',
    }));

    const result = await handleResourceIngest(
      { resourceId: 'res-cookie4', url: 'https://example.com/article' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('cookie_blocked');
  });

  it('does NOT false-positive on domains containing "cookie" (e.g. cookieconsent.org)', async () => {
    const body = '<html><body><h1>CookieConsent library docs</h1><p>How to add consent banners.</p></body></html>';
    mockFetchSource.mockResolvedValue(mockFetchResult({
      content: body,
      url: 'https://cookieconsent.org/docs/getting-started',
    }));

    const result = await handleResourceIngest(
      { resourceId: 'res-domain', url: 'https://cookieconsent.org/docs/getting-started' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('reachable');
  });
});
