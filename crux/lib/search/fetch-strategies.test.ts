/**
 * Tests for fetch-strategies.ts
 *
 * Covers: domain classification, forum content fetching, DOI resolution,
 * Wayback Machine content fetching.
 *
 * Network calls are mocked via vitest's built-in fetch mock.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  getContentFetchStrategy,
  isDeadDomain,
  isFirecrawlPriorityDomain,
  fetchForumContent,
  fetchDoiContent,
  fetchWaybackContent,
} from './fetch-strategies.ts';

// Mock the forum API module
vi.mock('../forum-api.ts', () => ({
  forumGraphql: vi.fn(),
}));

import { forumGraphql } from '../forum-api.ts';
const mockForumGraphql = vi.mocked(forumGraphql);

// ---------------------------------------------------------------------------
// Domain Classification Tests
// ---------------------------------------------------------------------------

describe('getContentFetchStrategy', () => {
  it('returns forum-api for LessWrong URLs', () => {
    expect(getContentFetchStrategy('https://www.lesswrong.com/posts/abc123/some-post')).toBe('forum-api');
    expect(getContentFetchStrategy('https://lesswrong.com/posts/abc123/some-post')).toBe('forum-api');
  });

  it('returns forum-api for Alignment Forum URLs', () => {
    expect(getContentFetchStrategy('https://www.alignmentforum.org/posts/xyz789/alignment-post')).toBe('forum-api');
    expect(getContentFetchStrategy('https://alignmentforum.org/posts/xyz789/alignment-post')).toBe('forum-api');
  });

  it('returns forum-api for EA Forum URLs', () => {
    expect(getContentFetchStrategy('https://forum.effectivealtruism.org/posts/abc/test')).toBe('forum-api');
  });

  it('returns wayback-only for known dead domains', () => {
    expect(getContentFetchStrategy('https://www.fhi.ox.ac.uk/paper.pdf')).toBe('wayback-only');
    expect(getContentFetchStrategy('https://fhi.ox.ac.uk/about')).toBe('wayback-only');
    expect(getContentFetchStrategy('https://ftxfuturefund.org/grants')).toBe('wayback-only');
  });

  it('returns doi for academic publisher domains', () => {
    expect(getContentFetchStrategy('https://www.nature.com/articles/s41586-021-03819-2')).toBe('doi');
    expect(getContentFetchStrategy('https://www.science.org/doi/10.1126/science.abc1234')).toBe('doi');
    expect(getContentFetchStrategy('https://www.sciencedirect.com/science/article/pii/S0123456789')).toBe('doi');
    expect(getContentFetchStrategy('https://pnas.org/doi/10.1073/pnas.123')).toBe('doi');
  });

  it('returns firecrawl-priority for bot-blocked domains', () => {
    expect(getContentFetchStrategy('https://openai.com/blog/some-post')).toBe('firecrawl-priority');
    expect(getContentFetchStrategy('https://www.rand.org/pubs/research-reports/RR1234.html')).toBe('firecrawl-priority');
    expect(getContentFetchStrategy('https://www.reuters.com/technology/ai-article')).toBe('firecrawl-priority');
    expect(getContentFetchStrategy('https://www.bloomberg.com/news/articles/ai')).toBe('firecrawl-priority');
    expect(getContentFetchStrategy('https://medium.com/some-article')).toBe('firecrawl-priority');
  });

  it('returns default for normal domains', () => {
    expect(getContentFetchStrategy('https://arxiv.org/abs/2301.12345')).toBe('default');
    expect(getContentFetchStrategy('https://en.wikipedia.org/wiki/AI')).toBe('default');
    expect(getContentFetchStrategy('https://example.com/page')).toBe('default');
    expect(getContentFetchStrategy('https://github.com/some/repo')).toBe('default');
  });

  it('handles invalid URLs gracefully', () => {
    expect(getContentFetchStrategy('')).toBe('default');
    expect(getContentFetchStrategy('not a url')).toBe('default');
  });
});

describe('isDeadDomain', () => {
  it('detects dead domains', () => {
    expect(isDeadDomain('https://www.fhi.ox.ac.uk/report')).toBe(true);
    expect(isDeadDomain('https://ftxfuturefund.org/grants')).toBe(true);
  });

  it('returns false for live domains', () => {
    expect(isDeadDomain('https://www.anthropic.com')).toBe(false);
    expect(isDeadDomain('https://openai.com')).toBe(false);
  });
});

describe('isFirecrawlPriorityDomain', () => {
  it('detects Firecrawl-priority domains', () => {
    expect(isFirecrawlPriorityDomain('https://openai.com/blog/gpt-4')).toBe(true);
    expect(isFirecrawlPriorityDomain('https://www.rand.org/pubs/report.html')).toBe(true);
  });

  it('returns false for normal domains', () => {
    expect(isFirecrawlPriorityDomain('https://arxiv.org/abs/1234')).toBe(false);
    expect(isFirecrawlPriorityDomain('https://en.wikipedia.org')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Forum Content Fetching
// ---------------------------------------------------------------------------

describe('fetchForumContent', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('fetches post content via GraphQL API', async () => {
    mockForumGraphql.mockResolvedValueOnce({
      data: {
        post: {
          result: {
            title: 'AI Alignment Research',
            contents: { markdown: 'This is the full post content about alignment.' },
            user: { displayName: 'John Doe' },
            coauthors: [{ displayName: 'Jane Smith' }],
            postedAt: '2025-01-15T12:00:00Z',
          },
        },
      },
    });

    const result = await fetchForumContent('https://www.lesswrong.com/posts/abc123/ai-alignment-research');

    expect(result).not.toBeNull();
    expect(result!.title).toBe('AI Alignment Research');
    expect(result!.content).toContain('AI Alignment Research');
    expect(result!.content).toContain('John Doe, Jane Smith');
    expect(result!.content).toContain('This is the full post content about alignment.');
    expect(result!.fetchMethod).toBe('forum-api');
    expect(result!.httpStatus).toBe(200);
  });

  it('returns null for non-forum URLs', async () => {
    const result = await fetchForumContent('https://example.com/page');
    expect(result).toBeNull();
  });

  it('returns null when post has no content', async () => {
    mockForumGraphql.mockResolvedValueOnce({
      data: {
        post: {
          result: {
            title: 'Empty Post',
            contents: { markdown: '' },
            user: { displayName: 'Test' },
          },
        },
      },
    });

    const result = await fetchForumContent('https://www.lesswrong.com/posts/abc123/empty');
    expect(result).toBeNull();
  });

  it('returns null when post is not found', async () => {
    mockForumGraphql.mockResolvedValueOnce({
      data: { post: { result: null } },
    });

    const result = await fetchForumContent('https://www.lesswrong.com/posts/notfound/missing');
    expect(result).toBeNull();
  });

  it('handles GraphQL errors gracefully', async () => {
    mockForumGraphql.mockRejectedValueOnce(new Error('GraphQL HTTP error: 500'));

    const result = await fetchForumContent('https://www.lesswrong.com/posts/abc/test');
    expect(result).toBeNull();
  });

  it('extracts post ID from sequence URLs', async () => {
    mockForumGraphql.mockResolvedValueOnce({
      data: {
        post: {
          result: {
            title: 'Sequence Post',
            contents: { markdown: 'Content from a sequence.' },
            user: { displayName: 'Author' },
          },
        },
      },
    });

    const result = await fetchForumContent('https://www.lesswrong.com/s/seqABC/p/postXYZ');
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Sequence Post');
    // Verify the correct post ID was passed to the GraphQL query
    expect(mockForumGraphql).toHaveBeenCalledWith(
      'https://www.lesswrong.com/graphql',
      expect.any(String),
      { id: 'postXYZ' },
    );
  });

  it('returns null for URLs without post ID', async () => {
    const result = await fetchForumContent('https://www.lesswrong.com/users/someuser');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DOI Resolution
// ---------------------------------------------------------------------------

describe('fetchDoiContent', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('resolves DOI and returns structured metadata', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        status: 'ok',
        message: {
          DOI: '10.1038/s41586-021-03819-2',
          title: ['Superhuman AI for protein structure prediction'],
          author: [
            { given: 'John', family: 'Jumper' },
            { given: 'Richard', family: 'Evans' },
          ],
          abstract: '<p>Proteins are essential to life.</p>',
          'container-title': ['Nature'],
          'published-print': { 'date-parts': [[2021, 7, 15]] },
          'is-referenced-by-count': 12345,
        },
      }), { status: 200 }),
    );

    // URL must contain an actual DOI pattern (10.XXXX/...) for extraction to work
    const result = await fetchDoiContent('https://doi.org/10.1038/s41586-021-03819-2');

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Superhuman AI for protein structure prediction');
    expect(result!.content).toContain('John Jumper, Richard Evans');
    expect(result!.content).toContain('Nature');
    expect(result!.content).toContain('Proteins are essential to life.');
    expect(result!.fetchMethod).toBe('doi-crossref');
    expect(result!.resolvedUrl).toBe('https://doi.org/10.1038/s41586-021-03819-2');
  });

  it('returns null for URLs without a DOI', async () => {
    const result = await fetchDoiContent('https://example.com/no-doi-here');
    expect(result).toBeNull();
  });

  it('returns null when CrossRef API returns non-ok status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Not Found', { status: 404 }),
    );

    const result = await fetchDoiContent('https://doi.org/10.1234/nonexistent');
    expect(result).toBeNull();
  });

  it('handles fetch errors gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('timeout'));

    const result = await fetchDoiContent('https://doi.org/10.1234/test');
    expect(result).toBeNull();
  });

  it('extracts DOI from publisher URL paths', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        status: 'ok',
        message: {
          DOI: '10.1073/pnas.2012345678',
          title: ['A PNAS Paper'],
          abstract: 'Test abstract content here.',
          'is-referenced-by-count': 100,
        },
      }), { status: 200 }),
    );

    const result = await fetchDoiContent('https://www.pnas.org/doi/full/10.1073/pnas.2012345678');
    expect(result).not.toBeNull();
    expect(result!.title).toBe('A PNAS Paper');
  });
});

// ---------------------------------------------------------------------------
// Wayback Machine Content Fetching
// ---------------------------------------------------------------------------

describe('fetchWaybackContent', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches content from Wayback Machine', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    // Mock Wayback availability API
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({
        archived_snapshots: {
          closest: {
            url: 'https://web.archive.org/web/20230101/https://www.fhi.ox.ac.uk/report',
            timestamp: '20230101120000',
            available: true,
          },
        },
      }), { status: 200 }),
    );

    // Mock archive content fetch
    fetchSpy.mockResolvedValueOnce(
      new Response(
        '<html><head><title>FHI Report</title></head><body><p>This is an important report about existential risk from the Future of Humanity Institute. It covers various topics related to AI safety and global catastrophic risks.</p></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      ),
    );

    const result = await fetchWaybackContent('https://www.fhi.ox.ac.uk/report');

    expect(result).not.toBeNull();
    expect(result!.title).toBe('FHI Report');
    expect(result!.content).toContain('existential risk');
    expect(result!.fetchMethod).toBe('wayback');
    expect(result!.archiveUrl).toContain('web.archive.org');
  });

  it('returns null when no snapshot is available', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    // Availability API: no snapshot
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ archived_snapshots: {} }), { status: 200 }),
    );

    // Direct URL: 404
    fetchSpy.mockResolvedValueOnce(
      new Response('Not Found', { status: 404 }),
    );

    const result = await fetchWaybackContent('https://nonexistent-site.example.com/page');
    expect(result).toBeNull();
  });

  it('returns null when archived content is too short', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({
        archived_snapshots: {
          closest: { url: 'https://web.archive.org/web/2023/test', timestamp: '20230101', available: true },
        },
      }), { status: 200 }),
    );

    fetchSpy.mockResolvedValueOnce(
      new Response('<html><body>Too short</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const result = await fetchWaybackContent('https://example.com/short');
    expect(result).toBeNull();
  });
});
