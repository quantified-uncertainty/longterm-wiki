/**
 * Tests for resource-lookup.ts
 *
 * Covers: lazy loading, lookup by ID, lookup by URL (with normalization),
 * cache clearing, updateResourceFetchStatus, and graceful handling of
 * missing data.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock resource-io.ts loadResources to return test data
vi.mock('../resource-io.ts', () => ({
  loadResources: vi.fn(() => [
    {
      id: 'abc123def456',
      url: 'https://example.com/paper-one',
      title: 'AI Safety Paper One',
      type: 'paper',
      authors: ['Jane Smith'],
      summary: 'A paper about AI safety',
      tags: ['safety', 'alignment'],
      _sourceFile: 'test-resources',
    },
    {
      id: 'xyz789ghi012',
      url: 'https://www.example.org/blog-post/',
      title: 'Blog About Alignment',
      type: 'blog',
      tags: ['alignment'],
      _sourceFile: 'test-resources',
    },
  ]),
}));

// Mock fs for updateResourceFetchStatus write tests
const mockWriteFileSync = vi.fn();
const mockExistsSync = vi.fn().mockReturnValue(true);
const mockReadFileSync = vi.fn().mockReturnValue(`# Test Resources
- id: abc123def456
  url: https://example.com/paper-one
  title: AI Safety Paper One
  type: paper
- id: xyz789ghi012
  url: https://www.example.org/blog-post/
  title: Blog About Alignment
  type: blog
`);

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  };
});

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
      // The resource URL has www., lookup without should still match
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
      // First load
      const r1 = getResourceById('abc123def456');
      expect(r1).not.toBeNull();

      clearResourceCache();

      // After clear, should reload and still find it
      const r2 = getResourceById('abc123def456');
      expect(r2).not.toBeNull();
    });
  });

  describe('updateResourceFetchStatus', () => {
    it('writes fetch_status and fetched_at to the YAML file', () => {
      // Trigger cache load first
      getResourceById('abc123def456');

      updateResourceFetchStatus('abc123def456', {
        fetchStatus: 'ok',
        fetchedAt: '2026-01-15T10:00:00.000Z',
      });

      expect(mockWriteFileSync).toHaveBeenCalledOnce();
      const written = mockWriteFileSync.mock.calls[0][1] as string;
      expect(written).toContain('fetch_status: ok');
      expect(written).toContain('fetched_at:');
      expect(written).toContain('2026-01-15T10:00:00.000Z');
    });

    it('preserves YAML comment headers', () => {
      // Trigger cache load
      getResourceById('abc123def456');

      updateResourceFetchStatus('abc123def456', {
        fetchStatus: 'dead',
        fetchedAt: '2026-01-15T10:00:00.000Z',
      });

      expect(mockWriteFileSync).toHaveBeenCalledOnce();
      const written = mockWriteFileSync.mock.calls[0][1] as string;
      expect(written.startsWith('# Test Resources\n')).toBe(true);
    });

    it('does not overwrite existing title when fetchedTitle is provided', () => {
      getResourceById('abc123def456');

      updateResourceFetchStatus('abc123def456', {
        fetchStatus: 'ok',
        fetchedAt: '2026-01-15T10:00:00.000Z',
        fetchedTitle: 'New Title From Fetch',
      });

      // The entry already has a title ("AI Safety Paper One"), so it should NOT be replaced
      const written = mockWriteFileSync.mock.calls[0][1] as string;
      expect(written).toContain('AI Safety Paper One');
      expect(written).not.toContain('New Title From Fetch');
    });

    it('is a no-op when resource ID is not found', () => {
      getResourceById('abc123def456'); // trigger load

      updateResourceFetchStatus('nonexistent-id', {
        fetchStatus: 'dead',
        fetchedAt: '2026-01-15T10:00:00.000Z',
      });

      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it('is a no-op when YAML file does not exist on disk', () => {
      getResourceById('abc123def456'); // trigger load
      mockExistsSync.mockReturnValueOnce(false);

      updateResourceFetchStatus('abc123def456', {
        fetchStatus: 'dead',
        fetchedAt: '2026-01-15T10:00:00.000Z',
      });

      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it('handles YAML without comment headers', () => {
      mockReadFileSync.mockReturnValueOnce(`- id: abc123def456
  url: https://example.com/paper-one
  title: AI Safety Paper One
  type: paper
`);

      getResourceById('abc123def456');

      updateResourceFetchStatus('abc123def456', {
        fetchStatus: 'ok',
        fetchedAt: '2026-01-15T10:00:00.000Z',
      });

      expect(mockWriteFileSync).toHaveBeenCalledOnce();
      const written = mockWriteFileSync.mock.calls[0][1] as string;
      expect(written).toContain('fetch_status: ok');
      // Should not have stray comment lines
      expect(written.startsWith('-') || written.startsWith('\n')).toBe(true);
    });
  });
});
