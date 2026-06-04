/**
 * Tests for the wiki-server I/O helpers, focused on QUA-1071:
 *   - fetchMissingSources threads `retryAfterDays` into the query string
 *     (and omits it when 0 / unset, preserving legacy behaviour).
 *   - recordAttempts posts the batch and is a no-op on an empty list.
 *
 * apiRequest is mocked so these run with no network / wiki-server.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiRequest = vi.fn();
vi.mock('../../wiki-server/client.ts', () => ({ apiRequest: (...args: unknown[]) => apiRequest(...args) }));

const { fetchMissingSources, recordAttempts } = await import('../fetch.ts');

function okGet() {
  apiRequest.mockResolvedValue({ ok: true, data: { tables: {}, totalMissing: 0 } });
}

describe('fetchMissingSources retryAfterDays', () => {
  beforeEach(() => apiRequest.mockReset());

  it('adds retryAfterDays to the query string when positive', async () => {
    okGet();
    await fetchMissingSources({ limit: 200, retryAfterDays: 30 });
    const url = apiRequest.mock.calls[0][1] as string;
    expect(url).toContain('retryAfterDays=30');
    expect(url).toContain('limit=200');
  });

  it('omits retryAfterDays when 0', async () => {
    okGet();
    await fetchMissingSources({ limit: 200, retryAfterDays: 0 });
    expect(apiRequest.mock.calls[0][1] as string).not.toContain('retryAfterDays');
  });

  it('omits retryAfterDays when unset', async () => {
    okGet();
    await fetchMissingSources({ limit: 50 });
    expect(apiRequest.mock.calls[0][1] as string).not.toContain('retryAfterDays');
  });

  it('includes table filter alongside the window', async () => {
    okGet();
    await fetchMissingSources({ limit: 10, table: 'facts', retryAfterDays: 14 });
    const url = apiRequest.mock.calls[0][1] as string;
    expect(url).toContain('table=facts');
    expect(url).toContain('retryAfterDays=14');
  });
});

describe('recordAttempts', () => {
  beforeEach(() => apiRequest.mockReset());

  it('is a no-op for an empty batch (no request)', async () => {
    const n = await recordAttempts([]);
    expect(n).toBe(0);
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('posts the batch and returns the recorded count', async () => {
    apiRequest.mockResolvedValue({ ok: true, data: { recorded: 2 } });
    const n = await recordAttempts([
      { table: 'facts', recordId: '1', outcome: 'no-match' },
      { table: 'page_citations', recordId: '9', outcome: 'matched' },
    ]);
    expect(n).toBe(2);
    const [method, path, body] = apiRequest.mock.calls[0];
    expect(method).toBe('POST');
    expect(path).toBe('/api/sourcing/missing-sources/record-attempts');
    expect((body as { attempts: unknown[] }).attempts).toHaveLength(2);
  });

  it('returns 0 (best-effort) when the API errors', async () => {
    apiRequest.mockResolvedValue({ ok: false, message: 'boom' });
    const n = await recordAttempts([{ table: 'facts', recordId: '1', outcome: 'no-match' }]);
    expect(n).toBe(0);
  });
});
