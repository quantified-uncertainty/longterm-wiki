import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Save original env
const origUrl = process.env.LONGTERMWIKI_SERVER_URL;
const origKey = process.env.LONGTERMWIKI_SERVER_API_KEY;

describe('wiki-server-client', () => {
  let client: typeof import('./wiki-server-client.ts');

  beforeEach(async () => {
    vi.restoreAllMocks();
    // Re-import to get fresh module
    client = await import('./wiki-server-client.ts');
  });

  afterEach(() => {
    // Restore env
    if (origUrl !== undefined) process.env.LONGTERMWIKI_SERVER_URL = origUrl;
    else delete process.env.LONGTERMWIKI_SERVER_URL;
    if (origKey !== undefined) process.env.LONGTERMWIKI_SERVER_API_KEY = origKey;
    else delete process.env.LONGTERMWIKI_SERVER_API_KEY;
  });

  describe('isServerAvailable', () => {
    it('returns false when LONGTERMWIKI_SERVER_URL is not set', async () => {
      delete process.env.LONGTERMWIKI_SERVER_URL;
      const result = await client.isServerAvailable();
      expect(result).toBe(false);
    });

    it('returns false when server is unreachable', async () => {
      process.env.LONGTERMWIKI_SERVER_URL = 'http://localhost:19999';
      const result = await client.isServerAvailable();
      expect(result).toBe(false);
    });
  });

  describe('appendEditLogToServer', () => {
    it('returns null when server URL is not set', async () => {
      delete process.env.LONGTERMWIKI_SERVER_URL;
      const result = await client.appendEditLogToServer({
        pageId: 'test-page',
        date: '2026-02-20',
        tool: 'crux-fix',
        agency: 'automated',
      });
      expect(result).toBeNull();
    });
  });

  describe('getEditLogsForPage', () => {
    it('returns null when server URL is not set', async () => {
      delete process.env.LONGTERMWIKI_SERVER_URL;
      const result = await client.getEditLogsForPage('test-page');
      expect(result).toBeNull();
    });
  });

  describe('getEditLogStats', () => {
    it('returns null when server URL is not set', async () => {
      delete process.env.LONGTERMWIKI_SERVER_URL;
      const result = await client.getEditLogStats();
      expect(result).toBeNull();
    });
  });

  describe('appendEditLogBatch', () => {
    it('returns null when server URL is not set', async () => {
      delete process.env.LONGTERMWIKI_SERVER_URL;
      const result = await client.appendEditLogBatch([
        { pageId: 'p1', date: '2026-02-20', tool: 'crux-fix', agency: 'automated' },
      ]);
      expect(result).toBeNull();
    });
  });
});
