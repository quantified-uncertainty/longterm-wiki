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
  fetchRecordVerdicts,
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

describe('fetchRecordVerdicts — QUA-421 strict-mode behavior (QUA-448: no env-var override)', () => {
  const originalServerUrl = process.env.LONGTERMWIKI_SERVER_URL;
  const originalCi = process.env.CI;
  const originalStrict = process.env.STRICT_VERDICTS;
  const noSleep = async () => {};

  beforeEach(() => {
    process.env.LONGTERMWIKI_SERVER_URL = 'http://fake-server';
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
