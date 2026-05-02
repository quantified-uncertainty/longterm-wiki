/**
 * Tests for fetchJsonWithRetry + fetchRecordVerdicts strict-mode behavior
 * (QUA-421).
 *
 * Before QUA-421, a single transient HTTP failure during paginated fetches
 * of /api/sourcing/verdicts would cause the entire record-verdicts.json to
 * come out empty, silently zeroing every source-check dot on the site. These
 * tests guard against re-introducing that behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  fetchJsonWithRetry,
  fetchBulkItems,
  fetchRecordVerdicts,
  fetchPaginatedItems,
  setFullBuildMode,
} from '../wiki-server-data.mjs';

/** Build a minimal Response-like object for the mocked fetch. */
function mockResponse({ ok, status = 200, json = null } = {}) {
  return {
    ok,
    status,
    json: async () => json,
  };
}

/** Collect calls in order and return canned results from a queue. */
function makeQueueFetcher(responses) {
  const calls = [];
  const queue = [...responses];
  const fetcher = async (url, _init) => {
    calls.push(url);
    if (queue.length === 0) {
      throw new Error(`queue exhausted; unexpected call to ${url}`);
    }
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetcher, calls };
}

describe('fetchJsonWithRetry', () => {
  // Use a zero-sleep so the exponential-backoff doesn't slow tests.
  const noSleep = async () => {};

  it('returns the parsed body on a successful first attempt', async () => {
    const { fetcher } = makeQueueFetcher([
      mockResponse({ ok: true, json: { verdicts: [{ recordType: 'grant', recordId: 'g1' }] } }),
    ]);
    const result = await fetchJsonWithRetry('http://x', {
      fetchImpl: fetcher,
      sleepImpl: noSleep,
    });
    expect(result.ok).toBe(true);
    expect(result.data.verdicts).toHaveLength(1);
  });

  it('retries on HTTP 500 and returns the next successful response', async () => {
    const { fetcher, calls } = makeQueueFetcher([
      mockResponse({ ok: false, status: 500 }),
      mockResponse({ ok: true, json: { verdicts: [] } }),
    ]);
    const result = await fetchJsonWithRetry('http://x', {
      fetchImpl: fetcher,
      sleepImpl: noSleep,
      attempts: 3,
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('retries on HTTP 429 (rate limit)', async () => {
    const { fetcher, calls } = makeQueueFetcher([
      mockResponse({ ok: false, status: 429 }),
      mockResponse({ ok: true, json: { ok: 1 } }),
    ]);
    const result = await fetchJsonWithRetry('http://x', {
      fetchImpl: fetcher,
      sleepImpl: noSleep,
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('retries on network errors (thrown by fetch itself)', async () => {
    const { fetcher, calls } = makeQueueFetcher([
      new Error('ECONNRESET'),
      mockResponse({ ok: true, json: { ok: 1 } }),
    ]);
    const result = await fetchJsonWithRetry('http://x', {
      fetchImpl: fetcher,
      sleepImpl: noSleep,
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('does NOT retry on HTTP 404 (caller bug)', async () => {
    const { fetcher, calls } = makeQueueFetcher([
      mockResponse({ ok: false, status: 404 }),
    ]);
    const result = await fetchJsonWithRetry('http://x', {
      fetchImpl: fetcher,
      sleepImpl: noSleep,
      attempts: 3,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.retryable).toBe(false);
    expect(calls).toHaveLength(1); // no retry
  });

  it('does NOT retry on HTTP 400', async () => {
    const { fetcher, calls } = makeQueueFetcher([
      mockResponse({ ok: false, status: 400 }),
    ]);
    const result = await fetchJsonWithRetry('http://x', {
      fetchImpl: fetcher,
      sleepImpl: noSleep,
      attempts: 3,
    });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('returns failure after exhausting all retry attempts', async () => {
    const { fetcher, calls } = makeQueueFetcher([
      mockResponse({ ok: false, status: 503 }),
      mockResponse({ ok: false, status: 503 }),
      mockResponse({ ok: false, status: 503 }),
    ]);
    const result = await fetchJsonWithRetry('http://x', {
      fetchImpl: fetcher,
      sleepImpl: noSleep,
      attempts: 3,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.retryable).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('uses exponential backoff between attempts', async () => {
    const { fetcher } = makeQueueFetcher([
      mockResponse({ ok: false, status: 500 }),
      mockResponse({ ok: false, status: 500 }),
      mockResponse({ ok: true, json: {} }),
    ]);
    const sleeps = [];
    const sleepImpl = async (ms) => {
      sleeps.push(ms);
    };
    await fetchJsonWithRetry('http://x', {
      fetchImpl: fetcher,
      sleepImpl,
      attempts: 3,
      backoffMs: 100,
    });
    expect(sleeps).toEqual([100, 200]); // 100ms before attempt 2, 200ms before attempt 3
  });
});

describe('fetchBulkItems — QUA-1040', () => {
  const noSleep = async () => {};

  it('returns the items array on a successful single fetch', async () => {
    const { fetcher, calls } = makeQueueFetcher([
      mockResponse({
        ok: true,
        json: { grants: [{ id: 'g1' }, { id: 'g2' }, { id: 'g3' }] },
      }),
    ]);
    const result = await fetchBulkItems('http://x/api/grants/bulk', 'grants', {
      fetchImpl: fetcher,
      sleepImpl: noSleep,
    });
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(3);
    expect(result.items[0].id).toBe('g1');
    expect(calls).toHaveLength(1);
  });

  it('makes a SINGLE round-trip — no pagination', async () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({ id: `g${i}` }));
    const { fetcher, calls } = makeQueueFetcher([
      mockResponse({ ok: true, json: { grants: items } }),
    ]);
    const result = await fetchBulkItems('http://x/api/grants/bulk', 'grants', {
      fetchImpl: fetcher,
      sleepImpl: noSleep,
    });
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(1000);
    // The whole point of /bulk: one HTTP call regardless of dataset size.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('http://x/api/grants/bulk');
  });

  it('inherits retry behavior from fetchJsonWithRetry on transient 500', async () => {
    const { fetcher, calls } = makeQueueFetcher([
      mockResponse({ ok: false, status: 500 }),
      mockResponse({ ok: true, json: { items: [{ id: 1 }] } }),
    ]);
    const result = await fetchBulkItems('http://x/api/items/bulk', 'items', {
      fetchImpl: fetcher,
      sleepImpl: noSleep,
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('returns structured failure when the response key is missing', async () => {
    // /bulk handlers must put rows under the documented key — anything else
    // is a server-side regression that the caller should surface, not silently
    // treat as "0 rows".
    const { fetcher } = makeQueueFetcher([
      mockResponse({ ok: true, json: { wrongKey: [{ id: 1 }] } }),
    ]);
    const result = await fetchBulkItems('http://x/api/grants/bulk', 'grants', {
      fetchImpl: fetcher,
      sleepImpl: noSleep,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing array/i);
  });

  it('returns structured failure when the response key is not an array', async () => {
    const { fetcher } = makeQueueFetcher([
      mockResponse({ ok: true, json: { grants: 'oops' } }),
    ]);
    const result = await fetchBulkItems('http://x/api/grants/bulk', 'grants', {
      fetchImpl: fetcher,
      sleepImpl: noSleep,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing array/i);
  });

  it('returns structured failure after exhausting retries', async () => {
    const { fetcher, calls } = makeQueueFetcher([
      mockResponse({ ok: false, status: 503 }),
      mockResponse({ ok: false, status: 503 }),
      mockResponse({ ok: false, status: 503 }),
    ]);
    const result = await fetchBulkItems('http://x/api/grants/bulk', 'grants', {
      fetchImpl: fetcher,
      sleepImpl: noSleep,
      attempts: 3,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(calls).toHaveLength(3);
  });

  it('returns empty items array when the server returns an empty result', async () => {
    const { fetcher } = makeQueueFetcher([
      mockResponse({ ok: true, json: { grants: [], total: 0 } }),
    ]);
    const result = await fetchBulkItems('http://x/api/grants/bulk', 'grants', {
      fetchImpl: fetcher,
      sleepImpl: noSleep,
    });
    expect(result.ok).toBe(true);
    expect(result.items).toEqual([]);
  });

  it('falls back to paginated /all when /bulk returns 404 (deploy ordering)', async () => {
    // Simulate older wiki-server: /bulk → 404, /all paginates normally.
    const firstPage = Array.from({ length: 200 }, (_, i) => ({ id: `g${i}` }));
    const lastPage = [{ id: 'g-last' }];
    const { fetcher, calls } = makeQueueFetcher([
      mockResponse({ ok: false, status: 404 }),
      mockResponse({ ok: true, json: { grants: firstPage } }),
      mockResponse({ ok: true, json: { grants: lastPage } }),
    ]);
    const result = await fetchBulkItems('http://x/api/grants/bulk', 'grants', {
      fetchImpl: fetcher,
      sleepImpl: noSleep,
      paginatedFallbackUrl: 'http://x/api/grants/all',
    });
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(201);
    expect(calls[0]).toBe('http://x/api/grants/bulk');
    expect(calls[1]).toContain('offset=0');
    expect(calls[2]).toContain('offset=200');
  });

  it('does NOT fall back on 5xx — surfaces the error (so a real outage is not masked)', async () => {
    const { fetcher, calls } = makeQueueFetcher([
      mockResponse({ ok: false, status: 503 }),
      mockResponse({ ok: false, status: 503 }),
      mockResponse({ ok: false, status: 503 }),
    ]);
    const result = await fetchBulkItems('http://x/api/grants/bulk', 'grants', {
      fetchImpl: fetcher,
      sleepImpl: noSleep,
      paginatedFallbackUrl: 'http://x/api/grants/all',
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    // 3 attempts on /bulk, no fallback to /all — fallback is only for 404.
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.includes('/bulk'))).toBe(true);
  });

  it('does NOT fall back on 404 when no fallback URL is configured', async () => {
    const { fetcher, calls } = makeQueueFetcher([
      mockResponse({ ok: false, status: 404 }),
    ]);
    const result = await fetchBulkItems('http://x/api/grants/bulk', 'grants', {
      fetchImpl: fetcher,
      sleepImpl: noSleep,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(calls).toHaveLength(1);
  });
});

describe('fetchPaginatedItems — QUA-1040 deploy-ordering fallback', () => {
  const noSleep = async () => {};

  it('paginates with limit/offset and concatenates pages', async () => {
    const page0 = Array.from({ length: 200 }, (_, i) => ({ id: `g${i}` }));
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `g${200 + i}` }));
    const { fetcher, calls } = makeQueueFetcher([
      mockResponse({ ok: true, json: { grants: page0 } }),
      mockResponse({ ok: true, json: { grants: page1 } }),
    ]);
    const { fetchPaginatedItems } = await import('../wiki-server-data.mjs');
    const result = await fetchPaginatedItems('http://x/api/grants/all', 'grants', {
      fetchImpl: fetcher,
      sleepImpl: noSleep,
    });
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(300);
    // Each page got its own AbortSignal via fetchJsonWithRetry — that's the QUA-1000 fix.
    expect(calls[0]).toBe('http://x/api/grants/all?limit=200&offset=0');
    expect(calls[1]).toBe('http://x/api/grants/all?limit=200&offset=200');
  });

  it('stops when a page comes back short (last page)', async () => {
    const page0 = [{ id: 'a' }, { id: 'b' }];
    const { fetcher, calls } = makeQueueFetcher([
      mockResponse({ ok: true, json: { items: page0 } }),
    ]);
    const { fetchPaginatedItems } = await import('../wiki-server-data.mjs');
    const result = await fetchPaginatedItems('http://x/api/items/all', 'items', {
      fetchImpl: fetcher,
      sleepImpl: noSleep,
      pageSize: 200, // page came back with 2 < 200, so we stop
    });
    expect(result.ok).toBe(true);
    expect(result.items).toEqual(page0);
    expect(calls).toHaveLength(1);
  });

  it('surfaces failure with offset context', async () => {
    const page0 = Array.from({ length: 200 }, (_, i) => ({ id: i }));
    const { fetcher } = makeQueueFetcher([
      mockResponse({ ok: true, json: { items: page0 } }),
      mockResponse({ ok: false, status: 503 }),
      mockResponse({ ok: false, status: 503 }),
      mockResponse({ ok: false, status: 503 }),
    ]);
    const { fetchPaginatedItems } = await import('../wiki-server-data.mjs');
    const result = await fetchPaginatedItems('http://x/api/items/all', 'items', {
      fetchImpl: fetcher,
      sleepImpl: noSleep,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/offset=200/);
  });
});

describe('fetchRecordVerdicts — QUA-421 strict-mode behavior (QUA-448: no env-var override)', () => {
  const originalServerUrl = process.env.LONGTERMWIKI_SERVER_URL;
  const originalProdServerUrl = process.env.PROD_LONGTERMWIKI_SERVER_URL;
  const originalWikiServerEnv = process.env.WIKI_SERVER_ENV;
  const originalCi = process.env.CI;
  const originalStrict = process.env.STRICT_VERDICTS;
  const noSleep = async () => {};

  beforeEach(() => {
    process.env.LONGTERMWIKI_SERVER_URL = 'http://fake-server';
    // Disable QUA-747 slot-CWD auto-detect so tests are hermetic when run
    // from inside an a<N> slot. Also clear PROD_ vars in case they're set
    // from .env so getServerUrl() doesn't fall through to them.
    process.env.WIKI_SERVER_ENV = 'local';
    delete process.env.PROD_LONGTERMWIKI_SERVER_URL;
    delete process.env.CI;
    delete process.env.STRICT_VERDICTS;
    setFullBuildMode(false);
  });

  afterEach(() => {
    if (originalServerUrl !== undefined) {
      process.env.LONGTERMWIKI_SERVER_URL = originalServerUrl;
    } else {
      delete process.env.LONGTERMWIKI_SERVER_URL;
    }
    if (originalProdServerUrl !== undefined) {
      process.env.PROD_LONGTERMWIKI_SERVER_URL = originalProdServerUrl;
    } else {
      delete process.env.PROD_LONGTERMWIKI_SERVER_URL;
    }
    if (originalWikiServerEnv !== undefined) {
      process.env.WIKI_SERVER_ENV = originalWikiServerEnv;
    } else {
      delete process.env.WIKI_SERVER_ENV;
    }
    if (originalCi !== undefined) {
      process.env.CI = originalCi;
    } else {
      delete process.env.CI;
    }
    if (originalStrict !== undefined) {
      process.env.STRICT_VERDICTS = originalStrict;
    } else {
      delete process.env.STRICT_VERDICTS;
    }
    setFullBuildMode(false);
  });

  it('returns the collected map on fully successful paginated fetches', async () => {
    // Single page with 2 verdicts, then a short page to terminate pagination.
    const { fetcher } = makeQueueFetcher([
      mockResponse({
        ok: true,
        json: {
          verdicts: [
            { recordType: 'grant', recordId: 'g1', verdict: 'confirmed' },
            { recordType: 'grant', recordId: 'g2', verdict: 'partial' },
          ],
        },
      }),
    ]);
    const result = await fetchRecordVerdicts({ fetchImpl: fetcher, sleepImpl: noSleep });
    expect(Object.keys(result)).toEqual(['grant:g1', 'grant:g2']);
  });

  it('keys per-field verdicts as "recordType:recordId:fieldName"', async () => {
    const { fetcher } = makeQueueFetcher([
      mockResponse({
        ok: true,
        json: {
          verdicts: [
            { recordType: 'grant', recordId: 'g1', fieldName: null, verdict: 'confirmed' },
            { recordType: 'grant', recordId: 'g1', fieldName: 'amount', verdict: 'partial' },
          ],
        },
      }),
    ]);
    const result = await fetchRecordVerdicts({ fetchImpl: fetcher, sleepImpl: noSleep });
    expect(result['grant:g1']?.verdict).toBe('confirmed');
    expect(result['grant:g1:amount']?.verdict).toBe('partial');
  });

  it('in CI=true: throws when a page fails after all retries', async () => {
    process.env.CI = 'true';
    const { fetcher } = makeQueueFetcher([
      mockResponse({ ok: false, status: 503 }),
      mockResponse({ ok: false, status: 503 }),
      mockResponse({ ok: false, status: 503 }),
    ]);
    await expect(
      fetchRecordVerdicts({ fetchImpl: fetcher, sleepImpl: noSleep }),
    ).rejects.toThrow(/record-verdicts.*refusing to ship/i);
  });

  it('outside CI: returns partial results when a page fails (graceful degrade)', async () => {
    // No CI, no STRICT_VERDICTS. Non-CI context returns whatever it collected
    // before the failure, so local dev / agent gates aren't blocked by a
    // transient wiki-server hiccup.
    const firstPage = Array.from({ length: 200 }, (_, i) => ({
      recordType: 'grant',
      recordId: `g${i}`,
      verdict: 'confirmed',
    }));
    const { fetcher } = makeQueueFetcher([
      mockResponse({ ok: true, json: { verdicts: firstPage } }),
      // Page 2 fails — exhausts retries
      mockResponse({ ok: false, status: 503 }),
      mockResponse({ ok: false, status: 503 }),
      mockResponse({ ok: false, status: 503 }),
    ]);
    const result = await fetchRecordVerdicts({ fetchImpl: fetcher, sleepImpl: noSleep });
    expect(Object.keys(result)).toHaveLength(200);
    expect(result['grant:g0']).toBeDefined();
  });

  it('ignores STRICT_VERDICTS=0 in CI (escape hatch removed — QUA-448)', async () => {
    // Pre-QUA-448: STRICT_VERDICTS=0 would force non-strict even in CI,
    // defeating the whole point of the safety check. Now the env var is
    // a no-op; CI=true still throws.
    process.env.CI = 'true';
    process.env.STRICT_VERDICTS = '0';
    const { fetcher } = makeQueueFetcher([
      mockResponse({ ok: false, status: 503 }),
      mockResponse({ ok: false, status: 503 }),
      mockResponse({ ok: false, status: 503 }),
    ]);
    await expect(
      fetchRecordVerdicts({ fetchImpl: fetcher, sleepImpl: noSleep }),
    ).rejects.toThrow(/record-verdicts/i);
  });

  it('ignores STRICT_VERDICTS=1 outside CI (override removed — QUA-448)', async () => {
    // Pre-QUA-448: STRICT_VERDICTS=1 could force strict locally (for testing
    // the strict path). Removed for symmetry — no env-var override at all.
    // Outside CI, failures degrade gracefully regardless of the env var.
    process.env.STRICT_VERDICTS = '1';
    const firstPage = [
      { recordType: 'grant', recordId: 'g1', verdict: 'confirmed' },
    ];
    const { fetcher } = makeQueueFetcher([
      mockResponse({ ok: true, json: { verdicts: firstPage } }),
      mockResponse({ ok: false, status: 503 }),
      mockResponse({ ok: false, status: 503 }),
      mockResponse({ ok: false, status: 503 }),
    ]);
    const result = await fetchRecordVerdicts({ fetchImpl: fetcher, sleepImpl: noSleep });
    expect(Object.keys(result)).toHaveLength(1);
  });

  it('returns empty map when LONGTERMWIKI_SERVER_URL is not set', async () => {
    delete process.env.LONGTERMWIKI_SERVER_URL;
    const result = await fetchRecordVerdicts({});
    expect(result).toEqual({});
  });

  it('retries on transient 500s and still completes successfully', async () => {
    const firstPage = [
      { recordType: 'grant', recordId: 'g1', verdict: 'confirmed' },
    ];
    const { fetcher, calls } = makeQueueFetcher([
      // Attempt 1: flaky 500
      mockResponse({ ok: false, status: 500 }),
      // Attempt 2: succeeds
      mockResponse({ ok: true, json: { verdicts: firstPage } }),
    ]);
    const result = await fetchRecordVerdicts({ fetchImpl: fetcher, sleepImpl: noSleep });
    expect(result['grant:g1']?.verdict).toBe('confirmed');
    expect(calls).toHaveLength(2);
  });

  it('paginates correctly: issues offset=0, 200, 400 until a short page', async () => {
    const mkFullPage = (start) =>
      Array.from({ length: 200 }, (_, i) => ({
        recordType: 'grant',
        recordId: `g${start + i}`,
        verdict: 'confirmed',
      }));
    const { fetcher, calls } = makeQueueFetcher([
      mockResponse({ ok: true, json: { verdicts: mkFullPage(0) } }),
      mockResponse({ ok: true, json: { verdicts: mkFullPage(200) } }),
      mockResponse({ ok: true, json: { verdicts: [{ recordType: 'grant', recordId: 'g-last', verdict: 'confirmed' }] } }),
    ]);
    const result = await fetchRecordVerdicts({ fetchImpl: fetcher, sleepImpl: noSleep });
    expect(Object.keys(result)).toHaveLength(401);
    expect(calls[0]).toContain('offset=0');
    expect(calls[1]).toContain('offset=200');
    expect(calls[2]).toContain('offset=400');
  });
});

describe('fetchPaginatedItems — QUA-1000 per-page timeout regression', () => {
  // QUA-1040 changed the return shape from `T[] | null` to
  // `{ok: true, items: T[]} | {ok: false, reason, status}`. The QUA-1000
  // regression contract (per-page fresh signals, no shared budget across
  // pages or parallel callers) still applies — these tests are kept and
  // updated to the new shape.
  const noSleep = async () => {};

  it('paginates correctly across multiple full pages', async () => {
    const mkPage = (start, count) =>
      Array.from({ length: count }, (_, i) => ({ id: start + i }));
    const { fetcher, calls } = makeQueueFetcher([
      mockResponse({ ok: true, json: { items: mkPage(0, 200) } }),
      mockResponse({ ok: true, json: { items: mkPage(200, 200) } }),
      mockResponse({ ok: true, json: { items: mkPage(400, 7) } }),
    ]);
    const result = await fetchPaginatedItems('http://x/api/grants/all', 'items', {
      fetchImpl: fetcher,
      sleepImpl: noSleep,
    });
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(407);
    expect(calls[0]).toContain('limit=200&offset=0');
    expect(calls[1]).toContain('limit=200&offset=200');
    expect(calls[2]).toContain('limit=200&offset=400');
  });

  it('returns failure when a mid-pagination page exhausts retries', async () => {
    // QUA-1040: the legacy contract was `null` on partial failure; the new
    // contract is `{ok: false, reason, status}` so callers can surface the
    // reason instead of swallowing it. mergeCollection still treats this as
    // "no data" and falls back to YAML-only — same downstream behavior.
    const { fetcher } = makeQueueFetcher([
      mockResponse({ ok: true, json: { items: Array.from({ length: 200 }, (_, i) => ({ id: i })) } }),
      mockResponse({ ok: false, status: 503 }),
      mockResponse({ ok: false, status: 503 }),
      mockResponse({ ok: false, status: 503 }),
    ]);
    const result = await fetchPaginatedItems('http://x/api/grants/all', 'items', {
      fetchImpl: fetcher,
      sleepImpl: noSleep,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.reason).toMatch(/offset=200/);
  });

  it('retries transient 5xx within a page and continues', async () => {
    const { fetcher, calls } = makeQueueFetcher([
      mockResponse({ ok: false, status: 500 }), // transient on page 1
      mockResponse({ ok: true, json: { items: Array.from({ length: 200 }, (_, i) => ({ id: i })) } }),
      mockResponse({ ok: true, json: { items: [{ id: 200 }] } }), // short page → done
    ]);
    const result = await fetchPaginatedItems('http://x/api/grants/all', 'items', {
      fetchImpl: fetcher,
      sleepImpl: noSleep,
    });
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(201);
    expect(calls).toHaveLength(3);
  });

  it('uses a fresh AbortSignal per page (no shared signal across pages)', async () => {
    // Pre-QUA-1000, the inner fetchAllPages helper shared one AbortSignal
    // across every page fetch. Each page must now receive its own signal so
    // that a slow page doesn't poison subsequent pages with an exhausted budget.
    const seenSignals = [];
    const fetcher = async (_url, init) => {
      seenSignals.push(init.signal);
      return mockResponse({
        ok: true,
        json: { items: seenSignals.length < 3
          ? Array.from({ length: 200 }, (_, i) => ({ id: i }))
          : [{ id: 999 }] },
      });
    };
    await fetchPaginatedItems('http://x/api/grants/all', 'items', {
      fetchImpl: fetcher,
      sleepImpl: noSleep,
    });
    expect(seenSignals).toHaveLength(3);
    // Each call must have received a *different* AbortSignal instance — that's
    // the regression we're guarding against. A shared signal would make all
    // three references identical.
    const unique = new Set(seenSignals);
    expect(unique.size).toBe(3);
  });

  it('does not share AbortSignals across parallel pagination calls', async () => {
    // The QUA-1000 root cause: 11 parallel paginated fetchers in
    // mergePGRecordsIntoKB shared one 30s AbortSignal. When the wall-clock
    // budget elapsed, every in-flight request aborted at once. With
    // fetchPaginatedItems delegating each page to fetchJsonWithRetry, two
    // parallel calls must produce fully disjoint signal sets.
    const callerASignals = [];
    const callerBSignals = [];
    const makeFetcher = (sink) => async (_url, init) => {
      sink.push(init.signal);
      return mockResponse({ ok: true, json: { items: [{ id: 1 }] } });
    };
    await Promise.all([
      fetchPaginatedItems('http://x/api/grants/all', 'items', {
        fetchImpl: makeFetcher(callerASignals),
        sleepImpl: noSleep,
      }),
      fetchPaginatedItems('http://x/api/personnel/all', 'items', {
        fetchImpl: makeFetcher(callerBSignals),
        sleepImpl: noSleep,
      }),
    ]);
    expect(callerASignals).toHaveLength(1);
    expect(callerBSignals).toHaveLength(1);
    // The two calls must have completely disjoint signals; pre-fix they would
    // have shared the single fetchOpts.signal from line 1464.
    expect(callerASignals[0]).not.toBe(callerBSignals[0]);
  });

  it('handles empty first page gracefully', async () => {
    const { fetcher } = makeQueueFetcher([
      mockResponse({ ok: true, json: { items: [] } }),
    ]);
    const result = await fetchPaginatedItems('http://x/api/grants/all', 'items', {
      fetchImpl: fetcher,
      sleepImpl: noSleep,
    });
    expect(result.ok).toBe(true);
    expect(result.items).toEqual([]);
  });

  it('treats a missing itemsKey as a structural failure (does not silently return [])', async () => {
    // QUA-1040 contract change: the legacy version returned [] on a missing
    // key, which silently masked server-side regressions. The new version
    // surfaces the failure so callers (and `mergeCollection`) log a warning.
    const { fetcher } = makeQueueFetcher([
      mockResponse({ ok: true, json: { /* no items key */ } }),
    ]);
    const result = await fetchPaginatedItems('http://x/api/grants/all', 'items', {
      fetchImpl: fetcher,
      sleepImpl: noSleep,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing array/i);
  });
});
