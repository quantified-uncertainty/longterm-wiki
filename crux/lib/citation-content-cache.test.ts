import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCachedContent,
  setCachedContent,
  clearContentCache,
  contentCacheSize,
  contentCacheEvictions,
} from './citation-content-cache.ts';

function makeEntry(url: string, text = 'content') {
  return {
    url,
    fetchedAt: new Date().toISOString(),
    httpStatus: 200,
    contentType: 'text/html',
    pageTitle: `Title for ${url}`,
    fullText: text,
    contentLength: text.length,
  };
}

describe('citation-content-cache', () => {
  beforeEach(() => {
    clearContentCache();
  });

  it('returns null for unknown URL', () => {
    expect(getCachedContent('https://unknown.example.com')).toBeNull();
  });

  it('returns cached content after setCachedContent', () => {
    const entry = makeEntry('https://example.com/a');
    setCachedContent('https://example.com/a', entry);
    const result = getCachedContent('https://example.com/a');
    expect(result).not.toBeNull();
    expect(result!.url).toBe('https://example.com/a');
    expect(result!.fullText).toBe('content');
  });

  it('LRU refresh: accessing an entry moves it to most-recently-used', () => {
    // Insert A, B, C
    setCachedContent('a', makeEntry('a'));
    setCachedContent('b', makeEntry('b'));
    setCachedContent('c', makeEntry('c'));

    // Access A (moves it to end)
    getCachedContent('a');

    // Now fill cache to 500 to trigger eviction
    for (let i = 0; i < 498; i++) {
      setCachedContent(`fill-${i}`, makeEntry(`fill-${i}`));
    }
    // Cache now has 501 entries — B should be evicted (oldest after A was refreshed)
    expect(contentCacheSize()).toBe(500);
    expect(getCachedContent('b')).toBeNull(); // B was evicted
    expect(getCachedContent('a')).not.toBeNull(); // A survived (was refreshed)
  });

  it('evicts oldest entry when exceeding 500 entries', () => {
    for (let i = 0; i < 501; i++) {
      setCachedContent(`url-${i}`, makeEntry(`url-${i}`));
    }
    expect(contentCacheSize()).toBe(500);
    expect(contentCacheEvictions()).toBe(1);
    // The first entry (url-0) should have been evicted
    expect(getCachedContent('url-0')).toBeNull();
    // The last entry should still be present
    expect(getCachedContent('url-500')).not.toBeNull();
  });

  it('cumulative eviction counter increments across multiple evictions', () => {
    // Fill cache to 500
    for (let i = 0; i < 500; i++) {
      setCachedContent(`url-${i}`, makeEntry(`url-${i}`));
    }
    expect(contentCacheEvictions()).toBe(0);

    // Add 5 more to trigger 5 evictions
    for (let i = 500; i < 505; i++) {
      setCachedContent(`url-${i}`, makeEntry(`url-${i}`));
    }
    expect(contentCacheEvictions()).toBe(5);
    expect(contentCacheSize()).toBe(500);
  });

  it('clearContentCache resets size and eviction counter', () => {
    for (let i = 0; i < 505; i++) {
      setCachedContent(`url-${i}`, makeEntry(`url-${i}`));
    }
    expect(contentCacheSize()).toBe(500);
    expect(contentCacheEvictions()).toBe(5);

    clearContentCache();
    expect(contentCacheSize()).toBe(0);
    expect(contentCacheEvictions()).toBe(0);
  });

  it('updating existing entry replaces content', () => {
    setCachedContent('https://example.com/x', makeEntry('https://example.com/x', 'old'));
    setCachedContent('https://example.com/x', makeEntry('https://example.com/x', 'new'));

    const result = getCachedContent('https://example.com/x');
    expect(result!.fullText).toBe('new');
    expect(contentCacheSize()).toBe(1); // no duplicate
  });
});
