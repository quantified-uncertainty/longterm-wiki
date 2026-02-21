import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// Mock wiki-server-client to prevent real HTTP requests in tests
vi.mock('./wiki-server-client.ts', () => ({
  appendEditLogToServer: vi.fn().mockResolvedValue(null),
}));

import { appendEditLog, readEditLog, pageIdFromPath, logBulkFixes, getDefaultRequestedBy } from './edit-log.ts';
import { appendEditLogToServer } from './wiki-server-client.ts';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const EDIT_LOGS_DIR = path.join(ROOT, 'data/edit-logs');
const TEST_PAGE_ID = '__test-edit-log-page__';
const TEST_FILE = path.join(EDIT_LOGS_DIR, `${TEST_PAGE_ID}.yaml`);

describe('edit-log', () => {
  beforeEach(() => {
    // Clean up test file before each test
    if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
  });

  afterEach(() => {
    // Clean up after each test
    if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
  });

  describe('readEditLog', () => {
    it('returns empty array for non-existent page', () => {
      expect(readEditLog('nonexistent-page-xyz')).toEqual([]);
    });

    it('reads entries from an existing file', () => {
      fs.writeFileSync(TEST_FILE, `- date: "2026-01-15"\n  tool: crux-create\n  agency: ai-directed\n  requestedBy: ozzie\n  note: "Test entry"\n`);
      const entries = readEditLog(TEST_PAGE_ID);
      expect(entries).toHaveLength(1);
      expect(entries[0].tool).toBe('crux-create');
      expect(entries[0].agency).toBe('ai-directed');
      expect(entries[0].requestedBy).toBe('ozzie');
    });
  });

  describe('appendEditLog', () => {
    it('creates a new file for a page with no log', () => {
      appendEditLog(TEST_PAGE_ID, {
        date: '2026-02-13',
        tool: 'crux-create',
        agency: 'ai-directed',
        requestedBy: 'system',
        note: 'Test creation',
      });

      expect(fs.existsSync(TEST_FILE)).toBe(true);
      const entries = readEditLog(TEST_PAGE_ID);
      expect(entries).toHaveLength(1);
      expect(entries[0].date).toBe('2026-02-13');
      expect(entries[0].tool).toBe('crux-create');
      expect(entries[0].agency).toBe('ai-directed');
      expect(entries[0].note).toBe('Test creation');
    });

    it('appends to an existing log', () => {
      appendEditLog(TEST_PAGE_ID, {
        date: '2026-01-01',
        tool: 'crux-create',
        agency: 'ai-directed',
        note: 'First entry',
      });

      appendEditLog(TEST_PAGE_ID, {
        date: '2026-02-13',
        tool: 'crux-improve',
        agency: 'ai-directed',
        requestedBy: 'ozzie',
        note: 'Second entry',
      });

      const entries = readEditLog(TEST_PAGE_ID);
      expect(entries).toHaveLength(2);
      expect(entries[0].tool).toBe('crux-create');
      expect(entries[1].tool).toBe('crux-improve');
      expect(entries[1].requestedBy).toBe('ozzie');
    });

    it('defaults date to today if not provided', () => {
      appendEditLog(TEST_PAGE_ID, {
        tool: 'manual',
        agency: 'human',
      });

      const entries = readEditLog(TEST_PAGE_ID);
      expect(entries).toHaveLength(1);
      expect(entries[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('omits optional fields when not provided', () => {
      appendEditLog(TEST_PAGE_ID, {
        tool: 'crux-grade',
        agency: 'automated',
      });

      const entries = readEditLog(TEST_PAGE_ID);
      expect(entries).toHaveLength(1);
      expect(entries[0].requestedBy).toBeUndefined();
      expect(entries[0].note).toBeUndefined();
    });

    it('preserves empty string values for optional fields', () => {
      appendEditLog(TEST_PAGE_ID, {
        tool: 'manual',
        agency: 'human',
        requestedBy: '',
        note: '',
      });

      const entries = readEditLog(TEST_PAGE_ID);
      expect(entries).toHaveLength(1);
      expect(entries[0].requestedBy).toBe('');
      expect(entries[0].note).toBe('');
    });

    it('fires a dual-write to the wiki-server API', () => {
      const mockFn = vi.mocked(appendEditLogToServer);
      mockFn.mockClear();

      appendEditLog(TEST_PAGE_ID, {
        date: '2026-02-20',
        tool: 'crux-fix',
        agency: 'automated',
        note: 'Test dual-write',
      });

      expect(mockFn).toHaveBeenCalledOnce();
      expect(mockFn).toHaveBeenCalledWith({
        pageId: TEST_PAGE_ID,
        date: '2026-02-20',
        tool: 'crux-fix',
        agency: 'automated',
        requestedBy: null,
        note: 'Test dual-write',
      });
    });

    it('does not fail if server write rejects', () => {
      const mockFn = vi.mocked(appendEditLogToServer);
      mockFn.mockRejectedValueOnce(new Error('server down'));

      // Should not throw
      appendEditLog(TEST_PAGE_ID, {
        tool: 'crux-fix',
        agency: 'automated',
      });

      // YAML file should still be written
      const entries = readEditLog(TEST_PAGE_ID);
      expect(entries).toHaveLength(1);
    });
  });

  describe('pageIdFromPath', () => {
    it('extracts slug from absolute content path', () => {
      const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
      expect(pageIdFromPath(`${root}/content/docs/knowledge-base/organizations/open-philanthropy.mdx`)).toBe('open-philanthropy');
    });

    it('extracts slug from nested path', () => {
      const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
      expect(pageIdFromPath(`${root}/content/docs/knowledge-base/people/nick-bostrom.mdx`)).toBe('nick-bostrom');
    });

    it('handles index files', () => {
      const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
      expect(pageIdFromPath(`${root}/content/docs/knowledge-base/risks/index.mdx`)).toBe('risks');
    });
  });

  describe('getDefaultRequestedBy', () => {
    const origCrux = process.env.CRUX_REQUESTED_BY;
    const origUser = process.env.USER;

    afterEach(() => {
      // Restore originals
      if (origCrux !== undefined) process.env.CRUX_REQUESTED_BY = origCrux;
      else delete process.env.CRUX_REQUESTED_BY;
      if (origUser !== undefined) process.env.USER = origUser;
      else delete process.env.USER;
    });

    it('returns CRUX_REQUESTED_BY when set', () => {
      process.env.CRUX_REQUESTED_BY = 'ozzie';
      expect(getDefaultRequestedBy()).toBe('ozzie');
    });

    it('falls back to USER when CRUX_REQUESTED_BY is not set', () => {
      delete process.env.CRUX_REQUESTED_BY;
      process.env.USER = 'testuser';
      expect(getDefaultRequestedBy()).toBe('testuser');
    });

    it('falls back to system when neither env var is set', () => {
      delete process.env.CRUX_REQUESTED_BY;
      delete process.env.USER;
      expect(getDefaultRequestedBy()).toBe('system');
    });
  });

  describe('logBulkFixes', () => {
    const BULK_PAGE_1 = '__test-bulk-1__';
    const BULK_PAGE_2 = '__test-bulk-2__';
    const BULK_FILE_1 = path.join(EDIT_LOGS_DIR, `${BULK_PAGE_1}.yaml`);
    const BULK_FILE_2 = path.join(EDIT_LOGS_DIR, `${BULK_PAGE_2}.yaml`);

    afterEach(() => {
      if (fs.existsSync(BULK_FILE_1)) fs.unlinkSync(BULK_FILE_1);
      if (fs.existsSync(BULK_FILE_2)) fs.unlinkSync(BULK_FILE_2);
    });

    it('creates entries for multiple pages', () => {
      const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
      logBulkFixes(
        [
          `${root}/content/docs/test/${BULK_PAGE_1}.mdx`,
          `${root}/content/docs/test/${BULK_PAGE_2}.mdx`,
        ],
        { tool: 'crux-fix', agency: 'automated', note: 'Test bulk fix' },
      );

      const entries1 = readEditLog(BULK_PAGE_1);
      const entries2 = readEditLog(BULK_PAGE_2);
      expect(entries1).toHaveLength(1);
      expect(entries2).toHaveLength(1);
      expect(entries1[0].tool).toBe('crux-fix');
      expect(entries2[0].note).toBe('Test bulk fix');
    });
  });
});
