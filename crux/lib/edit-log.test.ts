import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

// Mock wiki-server/edit-logs.ts to prevent real HTTP requests in tests
vi.mock('./wiki-server/edit-logs.ts', () => ({
  appendEditLogToServer: vi.fn().mockResolvedValue({
    ok: true,
    data: { id: 1, pageId: 'test', date: '2026-02-13', createdAt: '2026-02-13T00:00:00Z' },
  }),
  getEditLogsForPage: vi.fn().mockResolvedValue({ ok: false, error: 'unavailable', message: 'not set' }),
}));

import { appendEditLog, readEditLog, pageIdFromPath, logBulkFixes, getDefaultRequestedBy } from './edit-log.ts';
import { appendEditLogToServer, getEditLogsForPage } from './wiki-server/edit-logs.ts';

const TEST_PAGE_ID = '__test-edit-log-page__';

describe('edit-log', () => {
  beforeEach(() => {
    vi.mocked(appendEditLogToServer).mockClear();
    vi.mocked(getEditLogsForPage).mockClear();
    vi.mocked(getEditLogsForPage).mockResolvedValue({ ok: false, error: 'unavailable', message: 'not set' });
  });

  describe('readEditLog', () => {
    it('returns empty array when server is unavailable', async () => {
      vi.mocked(getEditLogsForPage).mockResolvedValue({ ok: false, error: 'unavailable', message: 'not set' });
      expect(await readEditLog('nonexistent-page-xyz')).toEqual([]);
    });

    it('reads entries from the server', async () => {
      vi.mocked(getEditLogsForPage).mockResolvedValue({
        ok: true,
        data: {
          entries: [{
            id: 1,
            pageId: TEST_PAGE_ID,
            date: '2026-01-15',
            tool: 'crux-create',
            agency: 'ai-directed',
            requestedBy: 'ozzie',
            note: 'Test entry',
            createdAt: '2026-01-15T00:00:00Z',
          }],
        },
      });
      const entries = await readEditLog(TEST_PAGE_ID);
      expect(entries).toHaveLength(1);
      expect(entries[0].tool).toBe('crux-create');
      expect(entries[0].agency).toBe('ai-directed');
      expect(entries[0].requestedBy).toBe('ozzie');
    });
  });

  describe('appendEditLog', () => {
    it('writes to the wiki-server API', async () => {
      await appendEditLog(TEST_PAGE_ID, {
        date: '2026-02-13',
        tool: 'crux-create',
        agency: 'ai-directed',
        requestedBy: 'system',
        note: 'Test creation',
      });

      expect(appendEditLogToServer).toHaveBeenCalledOnce();
      expect(appendEditLogToServer).toHaveBeenCalledWith({
        pageId: TEST_PAGE_ID,
        date: '2026-02-13',
        tool: 'crux-create',
        agency: 'ai-directed',
        requestedBy: 'system',
        note: 'Test creation',
      });
    });

    it('defaults date to today if not provided', async () => {
      await appendEditLog(TEST_PAGE_ID, {
        tool: 'manual',
        agency: 'human',
      });

      const call = vi.mocked(appendEditLogToServer).mock.calls[0][0];
      expect(call.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('omits optional fields when not provided', async () => {
      await appendEditLog(TEST_PAGE_ID, {
        tool: 'crux-grade',
        agency: 'automated',
      });

      const call = vi.mocked(appendEditLogToServer).mock.calls[0][0];
      expect(call.requestedBy).toBeNull();
      expect(call.note).toBeNull();
    });

    it('preserves empty string values for optional fields', async () => {
      await appendEditLog(TEST_PAGE_ID, {
        tool: 'manual',
        agency: 'human',
        requestedBy: '',
        note: '',
      });

      const call = vi.mocked(appendEditLogToServer).mock.calls[0][0];
      expect(call.requestedBy).toBe('');
      expect(call.note).toBe('');
    });

    it('returns the ApiResult from the server', async () => {
      const result = await appendEditLog(TEST_PAGE_ID, {
        tool: 'crux-fix',
        agency: 'automated',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.id).toBe(1);
        expect(result.data.pageId).toBe('test');
      }
    });

    it('returns error ApiResult and logs warning when server write fails', async () => {
      vi.mocked(appendEditLogToServer).mockResolvedValueOnce({
        ok: false,
        error: 'unavailable',
        message: 'LONGTERMWIKI_SERVER_URL not set',
      });

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const result = await appendEditLog(TEST_PAGE_ID, {
        tool: 'crux-fix',
        agency: 'automated',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('unavailable');
      }

      stderrSpy.mockRestore();
      consoleErrorSpy.mockRestore();
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
    it('creates entries for multiple pages', async () => {
      const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
      const results = await logBulkFixes(
        [
          `${root}/content/docs/test/__test-bulk-1__.mdx`,
          `${root}/content/docs/test/__test-bulk-2__.mdx`,
        ],
        { tool: 'crux-fix', agency: 'automated', note: 'Test bulk fix' },
      );

      expect(appendEditLogToServer).toHaveBeenCalledTimes(2);
      const calls = vi.mocked(appendEditLogToServer).mock.calls;
      expect(calls[0][0].pageId).toBe('__test-bulk-1__');
      expect(calls[1][0].pageId).toBe('__test-bulk-2__');
      expect(calls[0][0].tool).toBe('crux-fix');
      expect(calls[1][0].note).toBe('Test bulk fix');

      // Results array has one entry per file
      expect(results).toHaveLength(2);
      expect(results[0].ok).toBe(true);
      expect(results[1].ok).toBe(true);
    });
  });
});
