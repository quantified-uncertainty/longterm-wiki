/**
 * Tests for resource-lookup.ts
 *
 * Covers: lazy loading, lookup by ID, lookup by URL (with normalization),
 * cache clearing, and graceful handling of missing data.
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
    },
    {
      id: 'xyz789ghi012',
      url: 'https://www.example.org/blog-post/',
      title: 'Blog About Alignment',
      type: 'blog',
      tags: ['alignment'],
    },
  ]),
}));

import {
  getResourceById,
  getResourceByUrl,
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
