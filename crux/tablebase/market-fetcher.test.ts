import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the wiki-server client (imported transitively by market-fetcher.ts)
vi.mock('../lib/wiki-server/client.ts', () => ({
  apiRequest: vi.fn(),
}));

describe('fetchManifoldQuestion', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    warnSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  const mockResponse = (body: unknown, ok = true, status = 200) =>
    ({
      ok,
      status,
      json: async () => body,
    }) as unknown as Response;

  it('returns probability and does NOT warn for BINARY markets', async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({
        id: 'abc',
        outcomeType: 'BINARY',
        probability: 0.73,
        uniqueBettorCount: 42,
      })
    );

    const { fetchManifoldQuestion } = await import('./market-fetcher.ts');
    const result = await fetchManifoldQuestion('will-x-happen');

    expect(result).toEqual({
      probability: 0.73,
      probabilityLow: null,
      probabilityHigh: null,
      numForecasters: 42,
    });
    // No warning for a valid BINARY market
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('emits a WARN naming the outcomeType for MULTIPLE_CHOICE markets', async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({
        id: 'xyz',
        outcomeType: 'MULTIPLE_CHOICE',
        // probability absent — Manifold only populates it for BINARY
        uniqueBettorCount: 101,
      })
    );

    const { fetchManifoldQuestion } = await import('./market-fetcher.ts');
    const result = await fetchManifoldQuestion('some-poll-slug');

    // Still returns the SnapshotData shape with null probability, so the
    // caller's guard at market-fetcher.ts:~359 skips it from upsert.
    expect(result).toMatchObject({ probability: null });

    // The critical assertion: we WARN with market id + outcomeType so the
    // skip is traceable instead of silent.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).toContain('some-poll-slug');
    expect(msg).toContain('MULTIPLE_CHOICE');
    expect(msg).toContain('QUA-188');
  });

  it('emits a WARN for BINARY markets that nonetheless return null probability', async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({
        id: 'def',
        outcomeType: 'BINARY',
        // probability absent — e.g. resolved or closed
      })
    );

    const { fetchManifoldQuestion } = await import('./market-fetcher.ts');
    await fetchManifoldQuestion('resolved-market');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).toContain('resolved-market');
    expect(msg).toContain('BINARY');
    expect(msg).toContain('null probability');
  });

  it('handles missing outcomeType gracefully and still warns', async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({
        id: 'ghi',
        // no outcomeType, no probability — malformed response
      })
    );

    const { fetchManifoldQuestion } = await import('./market-fetcher.ts');
    await fetchManifoldQuestion('weird-slug');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).toContain('weird-slug');
    expect(msg).toContain('UNKNOWN');
  });

  it('does not warn about outcomeType when the HTTP request fails', async () => {
    fetchSpy.mockResolvedValue(mockResponse({}, false, 404));

    const { fetchManifoldQuestion } = await import('./market-fetcher.ts');
    const result = await fetchManifoldQuestion('missing-slug');

    expect(result).toBeNull();
    // Exactly one warn, about the HTTP status — NOT the outcomeType path.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).toContain('404');
    expect(msg).not.toContain('outcomeType');
  });
});
