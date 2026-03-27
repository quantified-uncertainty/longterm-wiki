/**
 * Tests for suggest-resources.ts
 *
 * Covers: orchestration of wiki-server suggest API + content fetching.
 * All external calls are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { suggestResources } from './suggest-resources.ts';

// Mock the wiki-server client
const mockSuggestApi = vi.fn();
vi.mock('../wiki-server/resources.ts', () => ({
  suggestResourcesApi: (...args: unknown[]) => mockSuggestApi(...args),
}));

// Mock the source fetcher
const mockFetchSources = vi.fn();
vi.mock('./source-fetcher.ts', () => ({
  fetchSource: vi.fn(),
  fetchSources: (...args: unknown[]) => mockFetchSources(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('suggestResources', () => {
  it('returns empty array for empty input', async () => {
    const result = await suggestResources({ urls: [] });
    expect(result.resources).toEqual([]);
    expect(result.fetchedCount).toBe(0);
    expect(result.cachedCount).toBe(0);
    expect(result.errorCount).toBe(0);
    expect(mockSuggestApi).not.toHaveBeenCalled();
  });

  it('skips fetching for URLs with fresh content', async () => {
    mockSuggestApi.mockResolvedValue({
      ok: true,
      data: {
        results: [
          { url: 'https://example.com/a', resourceId: 'abc123', contentStatus: 'fresh', title: 'Page A' },
          { url: 'https://example.com/b', resourceId: 'def456', contentStatus: 'fresh', title: 'Page B' },
        ],
      },
    });

    const result = await suggestResources({
      urls: ['https://example.com/a', 'https://example.com/b'],
    });

    expect(result.resources).toHaveLength(2);
    expect(result.cachedCount).toBe(2);
    expect(result.fetchedCount).toBe(0);
    expect(result.errorCount).toBe(0);
    expect(mockFetchSources).not.toHaveBeenCalled();
    expect(result.resources[0].status).toBe('ok');
    expect(result.resources[0].resourceId).toBe('abc123');
  });

  it('fetches content for URLs with missing/stale status', async () => {
    mockSuggestApi.mockResolvedValue({
      ok: true,
      data: {
        results: [
          { url: 'https://example.com/new', resourceId: 'new123', contentStatus: 'missing', title: null },
          { url: 'https://example.com/old', resourceId: 'old456', contentStatus: 'stale', title: 'Old Page' },
          { url: 'https://example.com/ok', resourceId: 'ok789', contentStatus: 'fresh', title: 'Fresh' },
        ],
      },
    });

    mockFetchSources.mockResolvedValue([
      { url: 'https://example.com/new', status: 'ok', content: 'New content here', title: 'New Page', httpStatus: 200, fetchedAt: '', relevantExcerpts: [] },
      { url: 'https://example.com/old', status: 'ok', content: 'Refreshed content', title: 'Old Page Updated', httpStatus: 200, fetchedAt: '', relevantExcerpts: [] },
    ]);

    const result = await suggestResources({
      urls: ['https://example.com/new', 'https://example.com/old', 'https://example.com/ok'],
    });

    expect(result.resources).toHaveLength(3);
    expect(result.cachedCount).toBe(1);
    expect(result.fetchedCount).toBe(2);
    expect(result.errorCount).toBe(0);

    // Verify fetchSources was called with the right URLs
    expect(mockFetchSources).toHaveBeenCalledOnce();
    const fetchRequests = mockFetchSources.mock.calls[0][0];
    expect(fetchRequests).toHaveLength(2);
    expect(fetchRequests[0].url).toBe('https://example.com/new');
    expect(fetchRequests[1].url).toBe('https://example.com/old');
    expect(fetchRequests[0].updateResourceStatus).toBe(true);

    // Verify results
    expect(result.resources[0]).toMatchObject({
      url: 'https://example.com/new',
      resourceId: 'new123',
      status: 'ok',
      title: 'New Page',
    });
    expect(result.resources[2]).toMatchObject({
      url: 'https://example.com/ok',
      status: 'ok',
    });
  });

  it('handles fetch failures per-URL without aborting', async () => {
    mockSuggestApi.mockResolvedValue({
      ok: true,
      data: {
        results: [
          { url: 'https://example.com/good', resourceId: 'g123', contentStatus: 'missing', title: null },
          { url: 'https://paywalled.com', resourceId: 'p456', contentStatus: 'missing', title: null },
        ],
      },
    });

    mockFetchSources.mockResolvedValue([
      { url: 'https://example.com/good', status: 'ok', content: 'Good content', title: 'Good', httpStatus: 200, fetchedAt: '', relevantExcerpts: [] },
      { url: 'https://paywalled.com', status: 'paywall', content: '', title: '', httpStatus: 403, fetchedAt: '', relevantExcerpts: [] },
    ]);

    const result = await suggestResources({
      urls: ['https://example.com/good', 'https://paywalled.com'],
    });

    expect(result.fetchedCount).toBe(1);
    expect(result.errorCount).toBe(1);
    expect(result.resources[0].status).toBe('ok');
    expect(result.resources[1].status).toBe('paywall');
  });

  it('throws when the wiki-server API call fails', async () => {
    mockSuggestApi.mockResolvedValue({
      ok: false,
      error: 'connection refused',
      message: 'connection refused',
    });

    await expect(
      suggestResources({ urls: ['https://example.com'] })
    ).rejects.toThrow('suggestResources API failed');
  });

  it('passes concurrency option to fetchSources', async () => {
    mockSuggestApi.mockResolvedValue({
      ok: true,
      data: {
        results: [
          { url: 'https://example.com', resourceId: 'x', contentStatus: 'missing', title: null },
        ],
      },
    });

    mockFetchSources.mockResolvedValue([
      { url: 'https://example.com', status: 'ok', content: 'c', title: 't', httpStatus: 200, fetchedAt: '', relevantExcerpts: [] },
    ]);

    await suggestResources({ urls: ['https://example.com'], concurrency: 10 });

    expect(mockFetchSources).toHaveBeenCalledWith(
      expect.any(Array),
      { concurrency: 10 },
    );
  });
});
