import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const origUrl = process.env.LONGTERMWIKI_SERVER_URL;
const origKey = process.env.LONGTERMWIKI_SERVER_API_KEY;

describe('wiki-server/artifacts', () => {
  let artifacts: typeof import('./artifacts.ts');

  beforeEach(async () => {
    vi.restoreAllMocks();
    artifacts = await import('./artifacts.ts');
  });

  afterEach(() => {
    if (origUrl !== undefined) process.env.LONGTERMWIKI_SERVER_URL = origUrl;
    else delete process.env.LONGTERMWIKI_SERVER_URL;
    if (origKey !== undefined) process.env.LONGTERMWIKI_SERVER_API_KEY = origKey;
    else delete process.env.LONGTERMWIKI_SERVER_API_KEY;
  });

  describe('saveArtifacts', () => {
    it('returns unavailable when server URL is not set', async () => {
      delete process.env.LONGTERMWIKI_SERVER_URL;
      const result = await artifacts.saveArtifacts({
        pageId: 'test-page',
        engine: 'v2',
        tier: 'standard',
        startedAt: new Date().toISOString(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('unavailable');
      }
    });

    it('returns unavailable when server is unreachable', async () => {
      process.env.LONGTERMWIKI_SERVER_URL = 'http://localhost:19999';
      const result = await artifacts.saveArtifacts({
        pageId: 'test-page',
        engine: 'v1',
        tier: 'polish',
        startedAt: new Date().toISOString(),
        durationS: 45.2,
        totalCost: 3.50,
        phasesRun: ['analyze', 'research', 'improve'],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('unavailable');
      }
    });
  });

  describe('getArtifactsByPage', () => {
    it('returns unavailable when server URL is not set', async () => {
      delete process.env.LONGTERMWIKI_SERVER_URL;
      const result = await artifacts.getArtifactsByPage('test-page');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('unavailable');
      }
    });
  });

  describe('getArtifacts', () => {
    it('returns unavailable when server URL is not set', async () => {
      delete process.env.LONGTERMWIKI_SERVER_URL;
      const result = await artifacts.getArtifacts();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('unavailable');
      }
    });
  });

  describe('getArtifact', () => {
    it('returns unavailable when server URL is not set', async () => {
      delete process.env.LONGTERMWIKI_SERVER_URL;
      const result = await artifacts.getArtifact(1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('unavailable');
      }
    });
  });

  describe('getArtifactStats', () => {
    it('returns unavailable when server URL is not set', async () => {
      delete process.env.LONGTERMWIKI_SERVER_URL;
      const result = await artifacts.getArtifactStats();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('unavailable');
      }
    });
  });
});
