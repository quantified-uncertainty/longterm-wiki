/**
 * Tests for resource-verify job handler.
 *
 * Covers:
 *  - Successful reachability check with content hash
 *  - Content change detection via previousContentHash
 *  - Soft-404 detection heuristics
 *  - Basic paywall detection
 *  - HTTP error codes (404, 500)
 *  - Timeout handling
 *  - SSRF protection (private hosts)
 *  - Invalid/non-HTTPS URLs
 *  - Bounded body read (large responses)
 *  - Param validation (missing/invalid)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import type { JobHandlerContext } from '../types.ts';

// ---------------------------------------------------------------------------
// Mock: isPrivateHost from source-fetcher
// ---------------------------------------------------------------------------

vi.mock('../../source-check/source-fetcher.ts', () => ({
  isPrivateHost: (host: string) =>
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.startsWith('10.') ||
    host.startsWith('192.168.'),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CTX: JobHandlerContext = {
  workerId: 'test-worker',
  projectRoot: '/tmp/test',
  verbose: false,
};

/** Compute the expected content hash (first 16 hex chars of SHA-256). */
function expectedHash(text: string): string {
  return createHash('sha256')
    .update(text.slice(0, 1_000_000))
    .digest('hex')
    .slice(0, 16);
}

/** Create a mock Response with configurable body and headers. */
function mockResponse(
  body: string,
  init?: { status?: number; headers?: Record<string, string>; url?: string },
): Response {
  const status = init?.status ?? 200;
  const headers = new Headers(init?.headers ?? {});
  if (!headers.has('content-type')) headers.set('content-type', 'text/html');

  // Build a ReadableStream so the handler can use response.body.getReader()
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });

  const res = new Response(stream, { status, headers });
  // Override the url property (Response constructor doesn't accept it)
  Object.defineProperty(res, 'url', { value: init?.url ?? 'https://example.com/page' });
  return res;
}

// ---------------------------------------------------------------------------
// Store original fetch so we can restore it
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Import handler (after mocks are set up)
// ---------------------------------------------------------------------------

const { handleResourceVerify } = await import('../resource-verify.ts');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleResourceVerify — param validation', () => {
  it('rejects missing resourceId', async () => {
    const result = await handleResourceVerify(
      { url: 'https://example.com' },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid params');
  });

  it('rejects missing url', async () => {
    const result = await handleResourceVerify(
      { resourceId: 'res-1' },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid params');
  });

  it('rejects invalid url format', async () => {
    const result = await handleResourceVerify(
      { resourceId: 'res-1', url: 'not-a-url' },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid params');
  });

  it('rejects empty resourceId', async () => {
    const result = await handleResourceVerify(
      { resourceId: '', url: 'https://example.com' },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid params');
  });
});

describe('handleResourceVerify — URL security', () => {
  it('rejects non-HTTPS URLs', async () => {
    const result = await handleResourceVerify(
      { resourceId: 'res-1', url: 'http://example.com/page' },
      CTX,
    );
    expect(result.success).toBe(true);
    expect(result.data.status).toBe('invalid_url');
    expect(result.data.error).toContain('Unsupported protocol');
  });

  it('rejects FTP URLs', async () => {
    const result = await handleResourceVerify(
      { resourceId: 'res-1', url: 'ftp://example.com/file' },
      CTX,
    );
    expect(result.success).toBe(true);
    expect(result.data.status).toBe('invalid_url');
  });

  it('blocks localhost (SSRF protection)', async () => {
    const result = await handleResourceVerify(
      { resourceId: 'res-1', url: 'https://localhost/admin' },
      CTX,
    );
    expect(result.success).toBe(true);
    expect(result.data.status).toBe('blocked');
    expect(result.data.error).toContain('SSRF');
  });

  it('blocks 127.0.0.1 (SSRF protection)', async () => {
    const result = await handleResourceVerify(
      { resourceId: 'res-1', url: 'https://127.0.0.1/secret' },
      CTX,
    );
    expect(result.success).toBe(true);
    expect(result.data.status).toBe('blocked');
  });

  it('blocks private network 10.x (SSRF protection)', async () => {
    const result = await handleResourceVerify(
      { resourceId: 'res-1', url: 'https://10.0.0.1/internal' },
      CTX,
    );
    expect(result.success).toBe(true);
    expect(result.data.status).toBe('blocked');
  });

  it('blocks private network 192.168.x (SSRF protection)', async () => {
    const result = await handleResourceVerify(
      { resourceId: 'res-1', url: 'https://192.168.1.1/router' },
      CTX,
    );
    expect(result.success).toBe(true);
    expect(result.data.status).toBe('blocked');
  });
});

describe('handleResourceVerify — successful checks', () => {
  it('returns reachable for a normal page', async () => {
    const body = '<html><body><h1>Real Article</h1><p>Content here about AI safety.</p></body></html>';
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(body));

    const result = await handleResourceVerify(
      { resourceId: 'res-1', url: 'https://example.com/article' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('reachable');
    expect(result.data.statusCode).toBe(200);
    expect(result.data.contentHash).toBe(expectedHash(body));
    expect(result.data.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('detects content change when previousContentHash differs', async () => {
    const body = 'Updated content';
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(body));

    const result = await handleResourceVerify(
      {
        resourceId: 'res-1',
        url: 'https://example.com/page',
        previousContentHash: 'aaaaaaaaaaaaaaaa',
      },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.contentChanged).toBe(true);
    expect(result.data.contentHash).not.toBe('aaaaaaaaaaaaaaaa');
  });

  it('detects no content change when hash matches', async () => {
    const body = 'Stable content';
    const hash = expectedHash(body);
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(body));

    const result = await handleResourceVerify(
      {
        resourceId: 'res-1',
        url: 'https://example.com/page',
        previousContentHash: hash,
      },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.contentChanged).toBe(false);
  });

  it('reports redirect in finalUrl', async () => {
    const body = 'Redirected content';
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse(body, { url: 'https://example.com/new-location' }),
    );

    const result = await handleResourceVerify(
      { resourceId: 'res-1', url: 'https://example.com/old-page' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('reachable');
    expect(result.data.finalUrl).toBe('https://example.com/new-location');
  });
});

describe('handleResourceVerify — HTTP errors', () => {
  it('returns not_found for HTTP 404', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse('Not Found', { status: 404 }),
    );

    const result = await handleResourceVerify(
      { resourceId: 'res-1', url: 'https://example.com/gone' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('not_found');
    expect(result.data.statusCode).toBe(404);
  });

  it('returns error for HTTP 500', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse('Server Error', { status: 500 }),
    );

    const result = await handleResourceVerify(
      { resourceId: 'res-1', url: 'https://example.com/broken' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('error');
    expect(result.data.statusCode).toBe(500);
  });

  it('returns error for HTTP 403', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse('Forbidden', { status: 403 }),
    );

    const result = await handleResourceVerify(
      { resourceId: 'res-1', url: 'https://example.com/forbidden' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('error');
    expect(result.data.statusCode).toBe(403);
  });
});

describe('handleResourceVerify — soft-404 detection', () => {
  it('detects "page not found" text in short page', async () => {
    const body = '<html><body><h1>Page not found</h1><p>Sorry, this page doesn\'t exist.</p></body></html>';
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(body));

    const result = await handleResourceVerify(
      { resourceId: 'res-1', url: 'https://example.com/missing' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('soft_404');
  });

  it('detects "Error 404" text in short page', async () => {
    const body = '<html><body>Error 404 - The page you requested could not be found.</body></html>';
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(body));

    const result = await handleResourceVerify(
      { resourceId: 'res-1', url: 'https://example.com/err' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('soft_404');
  });

  it('does NOT flag long pages mentioning 404 as soft-404', async () => {
    // A long article (>5KB) that happens to mention "404" should not be flagged
    const body = 'x'.repeat(6000) + ' error 404 mentioned in passing';
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(body));

    const result = await handleResourceVerify(
      { resourceId: 'res-1', url: 'https://example.com/long-article' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('reachable');
  });

  it('detects "content has been removed" in short page', async () => {
    const body = '<p>This content has been removed by the author.</p>';
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(body));

    const result = await handleResourceVerify(
      { resourceId: 'res-1', url: 'https://example.com/removed' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('soft_404');
  });
});

describe('handleResourceVerify — paywall detection', () => {
  it('detects "subscribe to continue" paywall', async () => {
    const body = '<p>Subscribe to continue reading this article.</p>';
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(body));

    const result = await handleResourceVerify(
      { resourceId: 'res-1', url: 'https://example.com/paywalled' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('paywall');
  });

  it('detects "members only" paywall', async () => {
    const body = '<div>This is members only content. Please sign up.</div>';
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(body));

    const result = await handleResourceVerify(
      { resourceId: 'res-1', url: 'https://example.com/members' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('paywall');
  });

  it('does NOT flag long pages with paywall keywords', async () => {
    // Real articles >10KB that mention "premium content" in passing should not be flagged
    const body = 'x'.repeat(11000) + ' premium content mentioned';
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(body));

    const result = await handleResourceVerify(
      { resourceId: 'res-1', url: 'https://example.com/long-article' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('reachable');
  });
});

describe('handleResourceVerify — network errors', () => {
  it('returns timeout on AbortError', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    globalThis.fetch = vi.fn().mockRejectedValue(abortError);

    const result = await handleResourceVerify(
      { resourceId: 'res-1', url: 'https://slow.example.com/page' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('timeout');
    expect(result.data.error).toContain('timed out');
  });

  it('returns unreachable on DNS failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    const result = await handleResourceVerify(
      { resourceId: 'res-1', url: 'https://nonexistent.example.com' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('unreachable');
    expect(result.data.error).toContain('fetch failed');
  });

  it('returns unreachable on connection refused', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));

    const result = await handleResourceVerify(
      { resourceId: 'res-1', url: 'https://example.com:9999/down' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('unreachable');
  });
});

describe('handleResourceVerify — large response handling', () => {
  it('skips body read for very large Content-Length', async () => {
    // Content-Length > 10MB triggers the skip
    const res = mockResponse('', {
      headers: { 'content-length': '15000000', 'content-type': 'application/pdf' },
    });
    globalThis.fetch = vi.fn().mockResolvedValue(res);

    const result = await handleResourceVerify(
      { resourceId: 'res-1', url: 'https://example.com/huge.pdf' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.data.status).toBe('reachable');
    expect(result.data.skippedBody).toBe(true);
    expect(result.data.contentLength).toBe(15000000);
  });
});
