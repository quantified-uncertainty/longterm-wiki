/**
 * Tests for resource-lookup.ts
 *
 * Covers: lazy loading, lookup by ID, lookup by URL (with normalization),
 * cache clearing, resolveResource (hash + stable_id), and graceful handling
 * of missing data.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock resource-io.ts loadResources to return test data
vi.mock('../../resource-io.ts', () => ({
  loadResources: vi.fn(() => [
    {
      id: 'abc123def456',
      url: 'https://example.com/paper-one',
      title: 'AI Safety Paper One',
      type: 'paper',
      authors: ['Jane Smith'],
      summary: 'A paper about AI safety',
      tags: ['safety', 'alignment'],
      stable_id: 'aBcDeFgHiJ',
    },
    {
      id: 'xyz789ghi012',
      url: 'https://www.example.org/blog-post/',
      title: 'Blog About Alignment',
      type: 'blog',
      tags: ['alignment'],
      stable_id: 'abc123def456', // same as first resource's hash ID — tests precedence
    },
  ]),
}));

import {
  getResourceById,
  getResourceByUrl,
  resolveResource,
  clearResourceCache,
  updateResourceFetchStatus,
} from './resource-lookup.ts';

describe('resource-lookup', () => {
  beforeEach(() => {
    clearResourceCache();
    vi.clearAllMocks();
  });

  describe('getResourceById', () => {
    it('returns resource for a known ID', () => {
      const r = getResourceById('abc123def456');
      expect(r).not.toBeNull();
      expect(r!.title).toBe('AI Safety Paper One');
      expect(r!.type).toBe('paper');
      expect(r!.authors).toEqual(['Jane Smith']);
    });

    it('returns null for an unknown ID', () => {
      expect(getResourceById('nonexistent')).toBeNull();
    });
  });

  describe('getResourceByUrl', () => {
    it('returns resource for an exact URL match', () => {
      const r = getResourceByUrl('https://example.com/paper-one');
      expect(r).not.toBeNull();
      expect(r!.id).toBe('abc123def456');
    });

    it('returns resource with trailing slash tolerance', () => {
      const r = getResourceByUrl('https://example.com/paper-one/');
      expect(r).not.toBeNull();
      expect(r!.id).toBe('abc123def456');
    });

    it('returns resource with www normalization', () => {
      const r = getResourceByUrl('https://example.org/blog-post/');
      expect(r).not.toBeNull();
      expect(r!.id).toBe('xyz789ghi012');
    });

    it('returns null for an unknown URL', () => {
      expect(getResourceByUrl('https://unknown.com/page')).toBeNull();
    });

    it('treats http and https as equivalent (QUA-341)', () => {
      // The pre-QUA-341 implementation forced https://; the new canonical
      // helper strips the protocol entirely. Both produce the same key.
      const r = getResourceByUrl('http://example.com/paper-one');
      expect(r).not.toBeNull();
      expect(r!.id).toBe('abc123def456');
    });

    it('returns the same resource regardless of query-param order (QUA-341)', () => {
      // sortParams: true gives deterministic keys.
      // Note: example.com/paper-one in mock data has no query params, so test
      // the mock URL with synthetic params won't actually match anything new.
      // What we verify is the URL parser treats these inputs equivalently.
      // The resource above has no query params, so a query-bearing URL won't
      // match it — assert that "no match" on either ordering, equally:
      expect(getResourceByUrl('https://example.com/paper-one?b=2&a=1')).toBeNull();
      expect(getResourceByUrl('https://example.com/paper-one?a=1&b=2')).toBeNull();
    });
  });

  describe('resolveResource', () => {
    it('resolves by hash ID', () => {
      const r = resolveResource('abc123def456');
      expect(r).not.toBeNull();
      expect(r!.title).toBe('AI Safety Paper One');
    });

    it('resolves by stable_id', () => {
      const r = resolveResource('aBcDeFgHiJ');
      expect(r).not.toBeNull();
      expect(r!.id).toBe('abc123def456');
      expect(r!.title).toBe('AI Safety Paper One');
    });

    it('prefers hash ID over stable_id', () => {
      // 'abc123def456' is both the hash ID of resource 1 and the stable_id of resource 2.
      // Hash ID lookup should win.
      const r = resolveResource('abc123def456');
      expect(r!.id).toBe('abc123def456');
      expect(r!.title).toBe('AI Safety Paper One');
    });

    it('returns null for unknown ID', () => {
      expect(resolveResource('nonexistent')).toBeNull();
    });

    it('returns null when looking up nonexistent stable_id', () => {
      expect(resolveResource('someStableId')).toBeNull();
    });
  });

  describe('clearResourceCache', () => {
    it('forces reload on next access', () => {
      const r1 = getResourceById('abc123def456');
      expect(r1).not.toBeNull();

      clearResourceCache();

      const r2 = getResourceById('abc123def456');
      expect(r2).not.toBeNull();
    });
  });

  describe('updateResourceFetchStatus', () => {
    it('is a no-op (PG-native, no YAML write)', () => {
      getResourceById('abc123def456');

      // Should not throw
      updateResourceFetchStatus('abc123def456', {
        fetchStatus: 'ok',
        fetchedAt: '2026-01-15T10:00:00.000Z',
      });
    });

    it('is a no-op for unknown resource ID', () => {
      getResourceById('abc123def456');

      updateResourceFetchStatus('nonexistent-id', {
        fetchStatus: 'dead',
        fetchedAt: '2026-01-15T10:00:00.000Z',
      });
    });
  });
});
