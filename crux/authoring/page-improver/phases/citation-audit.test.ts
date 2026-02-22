/**
 * Tests for the citation-audit phase.
 *
 * Tests cover:
 *   - buildAuditorSourceCache(): converting SourceCacheEntry[] → Map<string, FetchedSource>
 *
 * All tests are offline — no network calls, no LLM calls.
 */

import { describe, it, expect } from 'vitest';
import { buildAuditorSourceCache } from './citation-audit.ts';
import { MIN_SOURCE_CONTENT_LENGTH } from '../../../lib/citation-auditor.ts';
import type { SourceCacheEntry } from '../../../lib/section-writer.ts';

function makeEntry(overrides: Partial<SourceCacheEntry> = {}): SourceCacheEntry {
  return {
    id: 'SRC-1',
    url: 'https://example.com/article',
    title: 'Example Article',
    content: 'This is a long enough content string that passes the MIN_SOURCE_CONTENT_LENGTH threshold for ok status.',
    ...overrides,
  };
}

describe('buildAuditorSourceCache', () => {
  it('converts SourceCacheEntry[] into a Map keyed by URL', () => {
    const entries: SourceCacheEntry[] = [
      makeEntry({ url: 'https://example.com/a', content: 'A'.repeat(100) }),
      makeEntry({ id: 'SRC-2', url: 'https://example.com/b', content: 'B'.repeat(100) }),
    ];

    const cache = buildAuditorSourceCache(entries);
    expect(cache.size).toBe(2);
    expect(cache.has('https://example.com/a')).toBe(true);
    expect(cache.has('https://example.com/b')).toBe(true);
  });

  it('sets status=ok for entries with content longer than MIN_SOURCE_CONTENT_LENGTH chars', () => {
    const entry = makeEntry({ content: 'A'.repeat(MIN_SOURCE_CONTENT_LENGTH + 1) });
    const cache = buildAuditorSourceCache([entry]);
    expect(cache.get(entry.url)?.status).toBe('ok');
  });

  it('sets status=error for entries with content shorter than or equal to MIN_SOURCE_CONTENT_LENGTH chars', () => {
    const entry = makeEntry({ content: 'short' });
    const cache = buildAuditorSourceCache([entry]);
    expect(cache.get(entry.url)?.status).toBe('error');
  });

  it('sets status=error for entries with empty content', () => {
    const entry = makeEntry({ content: '' });
    const cache = buildAuditorSourceCache([entry]);
    expect(cache.get(entry.url)?.status).toBe('error');
  });

  it('preserves content and title from the source cache entry', () => {
    const entry = makeEntry({ title: 'My Title', content: 'Content text that is long enough to be valid.' + ' Extra text padding here.' });
    const cache = buildAuditorSourceCache([entry]);
    const fetched = cache.get(entry.url);
    expect(fetched?.title).toBe('My Title');
    expect(fetched?.content).toBe(entry.content);
  });

  it('returns empty Map for empty input', () => {
    const cache = buildAuditorSourceCache([]);
    expect(cache.size).toBe(0);
  });

  it('skips entries with no URL', () => {
    const entries: SourceCacheEntry[] = [
      makeEntry({ url: '' }),
      makeEntry({ id: 'SRC-2', url: 'https://example.com/valid', content: 'Valid content that is definitely long enough.' }),
    ];
    const cache = buildAuditorSourceCache(entries);
    expect(cache.size).toBe(1);
    expect(cache.has('https://example.com/valid')).toBe(true);
  });

  it('last entry wins for duplicate URLs', () => {
    const entries: SourceCacheEntry[] = [
      makeEntry({ id: 'SRC-1', url: 'https://example.com/dup', content: 'First content that is long enough to pass threshold.' }),
      makeEntry({ id: 'SRC-2', url: 'https://example.com/dup', content: 'Second content that is long enough to pass threshold.' }),
    ];
    const cache = buildAuditorSourceCache(entries);
    expect(cache.size).toBe(1);
    expect(cache.get('https://example.com/dup')?.content).toBe('Second content that is long enough to pass threshold.');
  });

  it('populates relevantExcerpts as empty array (adapts from SourceCacheEntry format)', () => {
    const entry = makeEntry({ content: 'A'.repeat(100) });
    const cache = buildAuditorSourceCache([entry]);
    expect(cache.get(entry.url)?.relevantExcerpts).toEqual([]);
  });

  it('handles entries at exactly the MIN_SOURCE_CONTENT_LENGTH content boundary', () => {
    // exactly MIN_SOURCE_CONTENT_LENGTH chars → status 'error' (not strictly greater)
    const borderEntry = makeEntry({ content: 'A'.repeat(MIN_SOURCE_CONTENT_LENGTH) });
    const cacheAtBoundary = buildAuditorSourceCache([borderEntry]);
    expect(cacheAtBoundary.get(borderEntry.url)?.status).toBe('error');

    // one char above → status 'ok'
    const aboveBoundaryEntry = makeEntry({ url: 'https://example.com/above', content: 'A'.repeat(MIN_SOURCE_CONTENT_LENGTH + 1) });
    const cacheAbove = buildAuditorSourceCache([aboveBoundaryEntry]);
    expect(cacheAbove.get(aboveBoundaryEntry.url)?.status).toBe('ok');
  });
});
