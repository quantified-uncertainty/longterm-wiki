import { describe, it, expect } from 'vitest';
import { filterBulkImportDates, resolveDateCreated, BULK_IMPORT_THRESHOLD } from '../git-date-utils.mjs';

describe('filterBulkImportDates', () => {
  it('returns all entries when no date exceeds the threshold', () => {
    const map = new Map([
      ['content/docs/page-a.mdx', '2026-02-15'],
      ['content/docs/page-b.mdx', '2026-02-16'],
      ['content/docs/page-c.mdx', '2026-02-15'],
    ]);

    const { filtered, discardedDates } = filterBulkImportDates(map);
    expect(filtered.size).toBe(3);
    expect(discardedDates).toHaveLength(0);
  });

  it('removes entries whose date exceeds the threshold', () => {
    // Use a small threshold for testing
    const map = new Map();
    // 10 files all with the same date (simulating bulk import)
    for (let i = 0; i < 10; i++) {
      map.set(`content/docs/bulk-${i}.mdx`, '2026-02-09');
    }
    // 3 files with unique dates (legitimate)
    map.set('content/docs/new-a.mdx', '2026-02-15');
    map.set('content/docs/new-b.mdx', '2026-02-16');
    map.set('content/docs/new-c.mdx', '2026-02-17');

    const { filtered, discardedDates } = filterBulkImportDates(map, 5);
    expect(filtered.size).toBe(3);
    expect(filtered.has('content/docs/new-a.mdx')).toBe(true);
    expect(filtered.has('content/docs/new-b.mdx')).toBe(true);
    expect(filtered.has('content/docs/new-c.mdx')).toBe(true);
    expect(filtered.has('content/docs/bulk-0.mdx')).toBe(false);
    expect(discardedDates).toHaveLength(1);
    expect(discardedDates[0]).toEqual({ date: '2026-02-09', fileCount: 10 });
  });

  it('removes multiple bulk-import dates', () => {
    const map = new Map();
    // First bulk import
    for (let i = 0; i < 8; i++) {
      map.set(`content/docs/import1-${i}.mdx`, '2026-01-01');
    }
    // Second bulk import
    for (let i = 0; i < 6; i++) {
      map.set(`content/docs/import2-${i}.mdx`, '2026-02-01');
    }
    // Legitimate pages
    map.set('content/docs/real.mdx', '2026-03-01');

    const { filtered, discardedDates } = filterBulkImportDates(map, 5);
    expect(filtered.size).toBe(1);
    expect(filtered.get('content/docs/real.mdx')).toBe('2026-03-01');
    expect(discardedDates).toHaveLength(2);
  });

  it('keeps entries at exactly the threshold (not strictly greater)', () => {
    const map = new Map();
    // Exactly 5 files with the same date
    for (let i = 0; i < 5; i++) {
      map.set(`content/docs/page-${i}.mdx`, '2026-02-09');
    }

    const { filtered, discardedDates } = filterBulkImportDates(map, 5);
    // 5 is not > 5, so these should be kept
    expect(filtered.size).toBe(5);
    expect(discardedDates).toHaveLength(0);
  });

  it('handles empty map', () => {
    const { filtered, discardedDates } = filterBulkImportDates(new Map());
    expect(filtered.size).toBe(0);
    expect(discardedDates).toHaveLength(0);
  });

  it('does not mutate the original map', () => {
    const map = new Map();
    for (let i = 0; i < 10; i++) {
      map.set(`content/docs/page-${i}.mdx`, '2026-02-09');
    }

    filterBulkImportDates(map, 5);
    expect(map.size).toBe(10); // original unchanged
  });

  it('uses the default threshold constant', () => {
    expect(BULK_IMPORT_THRESHOLD).toBe(50);
  });
});

describe('resolveDateCreated', () => {
  it('prefers frontmatter createdAt over all others', () => {
    const result = resolveDateCreated({
      fmCreatedAt: '2025-01-01',
      gitCreatedDate: '2026-02-15',
      earliestEditLogDate: '2026-02-20',
      fmDateCreated: '2025-06-01',
    });
    expect(result).toBe('2025-01-01');
  });

  it('falls back to git date when createdAt is null', () => {
    const result = resolveDateCreated({
      fmCreatedAt: null,
      gitCreatedDate: '2026-02-15',
      earliestEditLogDate: '2026-02-20',
      fmDateCreated: '2025-06-01',
    });
    expect(result).toBe('2026-02-15');
  });

  it('falls back to earliest edit log when git date is null', () => {
    const result = resolveDateCreated({
      fmCreatedAt: null,
      gitCreatedDate: null,
      earliestEditLogDate: '2026-02-20',
      fmDateCreated: '2025-06-01',
    });
    expect(result).toBe('2026-02-20');
  });

  it('falls back to legacy dateCreated when edit log is null', () => {
    const result = resolveDateCreated({
      fmCreatedAt: null,
      gitCreatedDate: null,
      earliestEditLogDate: null,
      fmDateCreated: '2025-06-01',
    });
    expect(result).toBe('2025-06-01');
  });

  it('returns null when all sources are null', () => {
    const result = resolveDateCreated({
      fmCreatedAt: null,
      gitCreatedDate: null,
      earliestEditLogDate: null,
      fmDateCreated: null,
    });
    expect(result).toBeNull();
  });

  it('skips empty strings (falsy values)', () => {
    const result = resolveDateCreated({
      fmCreatedAt: '',
      gitCreatedDate: '',
      earliestEditLogDate: '2026-02-20',
      fmDateCreated: null,
    });
    expect(result).toBe('2026-02-20');
  });
});
