/**
 * Tests for enrichment_status filtering in enrich-papers and enrich-forums.
 *
 * Bug: both commands process the first N resources regardless of enrichment_status,
 * re-enriching already-processed resources every run instead of skipping them.
 *
 * TDD: these tests FAIL before the fix (proving the bug) and PASS after.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock loadResourcesPGFirst before importing commands
vi.mock('../resource-io.ts', () => ({
  loadResourcesPGFirst: vi.fn(),
}));

// Mock apiRequest to prevent real HTTP calls
vi.mock('../lib/wiki-server/client.ts', () => ({
  apiRequest: vi.fn().mockResolvedValue({ ok: true, data: { upserted: { papers: 0, forumPosts: 0 } } }),
}));

// Mock sleep to not wait during tests
vi.mock('../resource-utils.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../resource-utils.ts')>();
  return {
    ...original,
    sleep: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock fetch globally — returns 404 so no enrichment data comes back,
// but we can count how many times it was called.
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
  ok: false,
  status: 404,
  json: async () => ({}),
} as Response));

import { loadResourcesPGFirst } from '../resource-io.ts';
import { enrichPapersCommand } from './enrich-papers.ts';
import { enrichForumsCommand } from './enrich-forums.ts';
import type { Resource } from '../resource-types.ts';

const mockedLoad = vi.mocked(loadResourcesPGFirst);
const mockedFetch = vi.mocked(fetch);

function makePaperResource(id: string, status?: string): Resource {
  return {
    id,
    url: `https://arxiv.org/abs/2301.${id.padStart(5, '0')}`,
    title: `Paper ${id}`,
    type: 'paper',
    enrichment_status: status,
  };
}

function makeForumResource(id: string, status?: string): Resource {
  return {
    id,
    url: `https://www.lesswrong.com/posts/${id}/some-post`,
    title: `Forum Post ${id}`,
    type: 'blog',
    enrichment_status: status,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Re-stub fetch default after clearAllMocks
  mockedFetch.mockResolvedValue({
    ok: false,
    status: 404,
    json: async () => ({}),
  } as Response);
});

describe('enrich-papers: enrichment_status filtering', () => {
  it('should NOT fetch data for already-enriched resources', async () => {
    mockedLoad.mockResolvedValue([
      makePaperResource('1', 'enriched'),
      makePaperResource('2', 'reviewed'),
      makePaperResource('3', undefined),  // should be processed
      makePaperResource('4', 'pending'),  // should be processed
    ]);

    await enrichPapersCommand([], { 'dry-run': true, limit: 200 });

    // Only resources 3 and 4 should trigger S2 API calls.
    // Bug: all 4 get processed → fetch called 4 times.
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it('should reach unenriched resources even when enriched ones come first', async () => {
    mockedLoad.mockResolvedValue([
      makePaperResource('1', 'enriched'),
      makePaperResource('2', 'enriched'),
      makePaperResource('3', undefined),
    ]);

    // With limit=2, buggy code takes resources 1+2 (both enriched), never sees 3.
    // Fixed code filters first, so resource 3 gets processed.
    await enrichPapersCommand([], { 'dry-run': true, limit: 2 });

    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });
});

describe('enrich-forums: enrichment_status filtering', () => {
  it('should NOT fetch data for already-enriched resources', async () => {
    mockedLoad.mockResolvedValue([
      makeForumResource('abc123', 'enriched'),
      makeForumResource('def456', 'reviewed'),
      makeForumResource('ghi789', undefined),  // should be processed
    ]);

    await enrichForumsCommand([], { 'dry-run': true, limit: 200 });

    // Only ghi789 should trigger a GraphQL call.
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });
});
