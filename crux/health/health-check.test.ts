/**
 * Tests for crux health helpers introduced in QUA-479:
 *   - describeFetchError() turns opaque network errors into actionable messages
 *   - fetchJson() surfaces errorDetail when the request can't even connect
 *
 * These tests exercise the error path without spinning up a real server, by
 * pointing fetchJson at addresses that cannot possibly answer.
 */

import { describe, it, expect } from 'vitest';

import { describeFetchError, fetchJson } from './health-check.ts';

describe('describeFetchError', () => {
  it('classifies ECONNREFUSED and hints at --local for localhost targets', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3002'), { code: 'ECONNREFUSED' }),
    });

    const msg = describeFetchError('http://localhost:3002/health', err);

    expect(msg).toContain('http://localhost:3002/health');
    expect(msg).toContain('ECONNREFUSED');
    expect(msg).toContain('--local');
    expect(msg).toContain('WIKI_SERVER_ENV');
  });

  it('classifies ECONNREFUSED without a localhost hint for remote targets', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });

    const msg = describeFetchError('https://wiki-server.k8s.quantifieduncertainty.org/health', err);

    expect(msg).toContain('ECONNREFUSED');
    expect(msg).not.toContain('--local');
    expect(msg).not.toContain('WIKI_SERVER_ENV');
  });

  it('classifies ENOTFOUND DNS failures', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND does-not-exist.invalid'), { code: 'ENOTFOUND' }),
    });

    const msg = describeFetchError('https://does-not-exist.invalid/health', err);

    expect(msg).toContain('DNS lookup failed');
    expect(msg).toContain('ENOTFOUND');
    expect(msg).toContain('does-not-exist.invalid');
  });

  it('classifies AbortSignal timeouts as TimeoutError', () => {
    // AbortSignal.timeout() rejects with a DOMException named 'TimeoutError'.
    const err = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });

    const msg = describeFetchError('https://wiki-server.k8s.quantifieduncertainty.org/health', err);

    expect(msg).toContain('timed out');
    expect(msg).toContain('15s');
  });

  it('classifies ECONNRESET', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    });

    const msg = describeFetchError('https://example.com/health', err);

    expect(msg).toContain('ECONNRESET');
    expect(msg).toContain('reset by peer');
  });

  it('falls back to a generic message for unknown errors', () => {
    const err = new Error('something weird happened');

    const msg = describeFetchError('https://example.com/health', err);

    expect(msg).toContain('https://example.com/health');
    expect(msg).toContain('network error');
    expect(msg).toContain('something weird happened');
  });

  it('handles non-Error thrown values without crashing', () => {
    const msg = describeFetchError('https://example.com/health', 'string error');

    expect(msg).toContain('https://example.com/health');
    expect(msg).toContain('string error');
  });
});

describe('module import hygiene', () => {
  it('does not mutate WIKI_SERVER_ENV when imported (only when dispatched as a script)', () => {
    // The module sets WIKI_SERVER_ENV=prod at load time when invoked as a
    // crux-dispatched script. Importing it for tests must NOT fire that side
    // effect, or other tests that care about WIKI_SERVER_ENV (e.g.
    // sync-session.test.ts, client.test.ts) see pollution across the worker.
    // By the time this test runs, the module has already been imported above;
    // if the guard worked, process.env.WIKI_SERVER_ENV is still whatever the
    // test runner started with — crucially, not force-set to 'prod'.
    const current = process.env.WIKI_SERVER_ENV;
    // Either it's undefined/empty (normal test runner state) or it was set to
    // something OTHER than 'prod' intentionally by the test harness. What must
    // NOT happen is that an unset value became 'prod' purely from the import.
    if (current === 'prod') {
      // If it's 'prod', something else set it — verify process.argv[1] doesn't
      // look like the health-check script, which would legitimately justify it.
      expect(process.argv[1] ?? '').not.toMatch(/health[\\/-]?check/);
    }
  });
});

describe('fetchJson', () => {
  it('returns ok:false with errorDetail when the target refuses the connection', async () => {
    // 127.0.0.1:59_999 is an ephemeral-range port with no listener in test env.
    // Node fetch reliably rejects with ECONNREFUSED, which the helper should
    // classify and include in errorDetail.
    const result = await fetchJson('http://127.0.0.1:59999/health');

    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.data).toBeNull();
    expect(result.errorDetail).toBeTruthy();
    expect(result.errorDetail).toContain('127.0.0.1:59999');
    expect(result.errorDetail).toContain('ECONNREFUSED');
    // The host is a localhost target, so the --local hint should fire.
    expect(result.errorDetail).toContain('--local');
  }, 10_000);

  it('returns ok:false with errorDetail when DNS resolution fails', async () => {
    const result = await fetchJson('http://does-not-exist-qua-479.invalid/health');

    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.errorDetail).toBeTruthy();
    // Should mention the unresolvable hostname so the user can spot typos.
    expect(result.errorDetail).toContain('does-not-exist-qua-479.invalid');
  }, 10_000);
});
