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

vi.mock('../../source-check/source-fetcher.ts', () => ({
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

  it('persists dead for not_found', async () => {
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
      expect.objectContaining({ fetchStatus: 'dead' }),
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
