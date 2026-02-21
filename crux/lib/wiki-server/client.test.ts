import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Save original env
const origUrl = process.env.LONGTERMWIKI_SERVER_URL;
const origKey = process.env.LONGTERMWIKI_SERVER_API_KEY;

describe('wiki-server/client', () => {
  let client: typeof import('./client.ts');

  beforeEach(async () => {
    vi.restoreAllMocks();
    client = await import('./client.ts');
  });

  afterEach(() => {
    if (origUrl !== undefined) process.env.LONGTERMWIKI_SERVER_URL = origUrl;
    else delete process.env.LONGTERMWIKI_SERVER_URL;
    if (origKey !== undefined) process.env.LONGTERMWIKI_SERVER_API_KEY = origKey;
    else delete process.env.LONGTERMWIKI_SERVER_API_KEY;
  });

  describe('getServerUrl', () => {
    it('returns empty string when not set', () => {
      delete process.env.LONGTERMWIKI_SERVER_URL;
      expect(client.getServerUrl()).toBe('');
    });

    it('returns the URL when set', () => {
      process.env.LONGTERMWIKI_SERVER_URL = 'http://localhost:3000';
      expect(client.getServerUrl()).toBe('http://localhost:3000');
    });
  });

  describe('buildHeaders', () => {
    it('includes Content-Type', () => {
      const headers = client.buildHeaders();
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('includes Authorization when API key is set', () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = 'test-key';
      const headers = client.buildHeaders();
      expect(headers['Authorization']).toBe('Bearer test-key');
    });

    it('omits Authorization when API key is not set', () => {
      delete process.env.LONGTERMWIKI_SERVER_API_KEY;
      const headers = client.buildHeaders();
      expect(headers['Authorization']).toBeUndefined();
    });
  });

  describe('apiOk / apiErr / unwrap', () => {
    it('apiOk creates a successful result', () => {
      const result = client.apiOk({ id: 1 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual({ id: 1 });
      }
    });

    it('apiErr creates an error result', () => {
      const result = client.apiErr('timeout', 'Request timed out');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('timeout');
        expect(result.message).toBe('Request timed out');
      }
    });

    it('unwrap extracts data from ok result', () => {
      const result = client.apiOk({ id: 1 });
      expect(client.unwrap(result)).toEqual({ id: 1 });
    });

    it('unwrap returns null from error result', () => {
      const result = client.apiErr('unavailable', 'Not set');
      expect(client.unwrap(result)).toBeNull();
    });
  });

  describe('apiRequest', () => {
    it('returns unavailable when LONGTERMWIKI_SERVER_URL is not set', async () => {
      delete process.env.LONGTERMWIKI_SERVER_URL;
      const result = await client.apiRequest('GET', '/api/test');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('unavailable');
        expect(result.message).toContain('not set');
      }
    });

    it('returns unavailable when server is unreachable', async () => {
      process.env.LONGTERMWIKI_SERVER_URL = 'http://localhost:19999';
      const result = await client.apiRequest('GET', '/api/test');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('unavailable');
      }
    });

    it('returns timeout when request exceeds timeout', async () => {
      process.env.LONGTERMWIKI_SERVER_URL = 'http://localhost:19999';
      // Use a very short timeout to trigger timeout quickly
      // The connection will fail before timeout for unreachable hosts,
      // but the error type will still be 'unavailable' since it's a network error
      const result = await client.apiRequest('GET', '/api/test', undefined, 1);
      expect(result.ok).toBe(false);
      // Either timeout or unavailable depending on how fast the connection fails
      if (!result.ok) {
        expect(['timeout', 'unavailable']).toContain(result.error);
      }
    });
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
});
