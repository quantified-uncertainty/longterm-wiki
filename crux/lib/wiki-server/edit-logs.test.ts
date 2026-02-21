import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const origUrl = process.env.LONGTERMWIKI_SERVER_URL;
const origKey = process.env.LONGTERMWIKI_SERVER_API_KEY;

describe('wiki-server/edit-logs', () => {
  let editLogs: typeof import('./edit-logs.ts');

  beforeEach(async () => {
    editLogs = await import('./edit-logs.ts');
  });

  afterEach(() => {
    if (origUrl !== undefined) process.env.LONGTERMWIKI_SERVER_URL = origUrl;
    else delete process.env.LONGTERMWIKI_SERVER_URL;
    if (origKey !== undefined) process.env.LONGTERMWIKI_SERVER_API_KEY = origKey;
    else delete process.env.LONGTERMWIKI_SERVER_API_KEY;
  });

  describe('appendEditLogToServer', () => {
    it('returns unavailable ApiResult when server URL is not set', async () => {
      delete process.env.LONGTERMWIKI_SERVER_URL;
      const result = await editLogs.appendEditLogToServer({
        pageId: 'test-page',
        date: '2026-02-20',
        tool: 'crux-fix',
        agency: 'automated',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('unavailable');
      }
    });
  });

  describe('getEditLogsForPage', () => {
    it('returns unavailable ApiResult when server URL is not set', async () => {
      delete process.env.LONGTERMWIKI_SERVER_URL;
      const result = await editLogs.getEditLogsForPage('test-page');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('unavailable');
      }
    });
  });

  describe('getEditLogStats', () => {
    it('returns unavailable ApiResult when server URL is not set', async () => {
      delete process.env.LONGTERMWIKI_SERVER_URL;
      const result = await editLogs.getEditLogStats();
      expect(result.ok).toBe(false);
    });
  });

  describe('appendEditLogBatch', () => {
    it('returns unavailable ApiResult when server URL is not set', async () => {
      delete process.env.LONGTERMWIKI_SERVER_URL;
      const result = await editLogs.appendEditLogBatch([
        { pageId: 'p1', date: '2026-02-20', tool: 'crux-fix', agency: 'automated' },
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('unavailable');
      }
    });
  });

});
