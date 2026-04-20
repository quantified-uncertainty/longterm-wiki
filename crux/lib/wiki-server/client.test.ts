import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Save original env
const origUrl = process.env.LONGTERMWIKI_SERVER_URL;
const origKey = process.env.LONGTERMWIKI_SERVER_API_KEY;
const origWikiServer = process.env.WIKI_SERVER_ENV;
const origProdUrl = process.env.PROD_LONGTERMWIKI_SERVER_URL;
const origProdKey = process.env.PROD_LONGTERMWIKI_SERVER_API_KEY;

describe('wiki-server/client', () => {
  let client: typeof import('./client.ts');

  beforeEach(async () => {
    vi.restoreAllMocks();
    // Opt out of slot auto-detection (QUA-616): if vitest runs from inside
    // `lw/aN/`, getEnvPrefix() would auto-select PROD_ when WIKI_SERVER_ENV
    // is unset. Setting 'local' makes these env-var tests deterministic
    // regardless of CWD.
    process.env.WIKI_SERVER_ENV = 'local';
    client = await import('./client.ts');
  });

  afterEach(() => {
    if (origUrl !== undefined) process.env.LONGTERMWIKI_SERVER_URL = origUrl;
    else delete process.env.LONGTERMWIKI_SERVER_URL;
    if (origKey !== undefined) process.env.LONGTERMWIKI_SERVER_API_KEY = origKey;
    else delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    if (origWikiServer !== undefined) process.env.WIKI_SERVER_ENV = origWikiServer;
    else delete process.env.WIKI_SERVER_ENV;
    if (origProdUrl !== undefined) process.env.PROD_LONGTERMWIKI_SERVER_URL = origProdUrl;
    else delete process.env.PROD_LONGTERMWIKI_SERVER_URL;
    if (origProdKey !== undefined) process.env.PROD_LONGTERMWIKI_SERVER_API_KEY = origProdKey;
    else delete process.env.PROD_LONGTERMWIKI_SERVER_API_KEY;
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

  describe('WIKI_SERVER_ENV=prod prefix', () => {
    it('getServerUrl uses PROD_ prefix when WIKI_SERVER_ENV=prod', () => {
      delete process.env.LONGTERMWIKI_SERVER_URL;
      process.env.WIKI_SERVER_ENV = 'prod';
      process.env.PROD_LONGTERMWIKI_SERVER_URL = 'https://prod.example.com';
      expect(client.getServerUrl()).toBe('https://prod.example.com');
    });

    it('getServerUrl uses PROD_ prefix when WIKI_SERVER_ENV=production', () => {
      delete process.env.LONGTERMWIKI_SERVER_URL;
      process.env.WIKI_SERVER_ENV = 'production';
      process.env.PROD_LONGTERMWIKI_SERVER_URL = 'https://prod.example.com';
      expect(client.getServerUrl()).toBe('https://prod.example.com');
    });

    it('getServerUrl ignores PROD_ vars without WIKI_SERVER_ENV flag', () => {
      process.env.LONGTERMWIKI_SERVER_URL = 'http://localhost:3000';
      process.env.PROD_LONGTERMWIKI_SERVER_URL = 'https://prod.example.com';
      // 'local' opts out of slot auto-detection (QUA-616); without this,
      // running the test from inside `lw/aN/` would pick PROD_ silently.
      process.env.WIKI_SERVER_ENV = 'local';
      expect(client.getServerUrl()).toBe('http://localhost:3000');
    });

    it('getApiKey uses PROD_ prefix when WIKI_SERVER_ENV=prod', () => {
      delete process.env.LONGTERMWIKI_SERVER_API_KEY;
      process.env.WIKI_SERVER_ENV = 'prod';
      process.env.PROD_LONGTERMWIKI_SERVER_API_KEY = 'prod-key';
      expect(client.getApiKey()).toBe('prod-key');
    });

    it('buildHeaders uses prod API key when WIKI_SERVER_ENV=prod', () => {
      delete process.env.LONGTERMWIKI_SERVER_API_KEY;
      process.env.WIKI_SERVER_ENV = 'prod';
      process.env.PROD_LONGTERMWIKI_SERVER_API_KEY = 'prod-key';
      const headers = client.buildHeaders();
      expect(headers['Authorization']).toBe('Bearer prod-key');
    });
  });

  describe('slot auto-detection (QUA-616)', () => {
    // These tests mock process.cwd() rather than CD'ing the vitest process,
    // which would affect every other test file.
    let cwdSpy: ReturnType<typeof vi.spyOn>;
    afterEach(() => {
      cwdSpy?.mockRestore();
    });

    it('auto-selects PROD_ when WIKI_SERVER_ENV is unset and CWD is inside a slot', () => {
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/home/user/lw/a7/apps/web');
      delete process.env.WIKI_SERVER_ENV;
      process.env.LONGTERMWIKI_SERVER_URL = 'http://localhost:3113';
      process.env.PROD_LONGTERMWIKI_SERVER_URL = 'https://prod.example.com';
      expect(client.getServerUrl()).toBe('https://prod.example.com');
    });

    it('does NOT auto-select PROD_ when CWD is outside any slot', () => {
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/home/user/lw/main/apps/web');
      delete process.env.WIKI_SERVER_ENV;
      process.env.LONGTERMWIKI_SERVER_URL = 'http://localhost:3113';
      process.env.PROD_LONGTERMWIKI_SERVER_URL = 'https://prod.example.com';
      expect(client.getServerUrl()).toBe('http://localhost:3113');
    });

    it('respects explicit WIKI_SERVER_ENV=local from inside a slot (escape hatch)', () => {
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/home/user/lw/a7');
      process.env.WIKI_SERVER_ENV = 'local';
      process.env.LONGTERMWIKI_SERVER_URL = 'http://localhost:3113';
      process.env.PROD_LONGTERMWIKI_SERVER_URL = 'https://prod.example.com';
      expect(client.getServerUrl()).toBe('http://localhost:3113');
    });

    it('respects explicit WIKI_SERVER_ENV=prod from inside a slot', () => {
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/home/user/lw/a7');
      process.env.WIKI_SERVER_ENV = 'prod';
      process.env.LONGTERMWIKI_SERVER_URL = 'http://localhost:3113';
      process.env.PROD_LONGTERMWIKI_SERVER_URL = 'https://prod.example.com';
      expect(client.getServerUrl()).toBe('https://prod.example.com');
    });

    it('slot auto-detect also drives getApiKey (so headers use the prod key)', () => {
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/home/user/lw/a3');
      delete process.env.WIKI_SERVER_ENV;
      process.env.LONGTERMWIKI_SERVER_API_KEY = 'local-key';
      process.env.PROD_LONGTERMWIKI_SERVER_API_KEY = 'prod-key';
      expect(client.getApiKey()).toBe('prod-key');
      expect(client.buildHeaders()['Authorization']).toBe('Bearer prod-key');
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

    it('returns auth_error for 401 response', async () => {
      process.env.LONGTERMWIKI_SERVER_URL = 'http://localhost:19999';
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Bearer token required', { status: 401 }),
      );
      const result = await client.apiRequest('GET', '/api/test');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('auth_error');
        expect(result.message).toContain('401');
      }
    });

    it('returns auth_error for 403 response', async () => {
      process.env.LONGTERMWIKI_SERVER_URL = 'http://localhost:19999';
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Forbidden', { status: 403 }),
      );
      const result = await client.apiRequest('GET', '/api/test');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('auth_error');
      }
    });

    it('returns bad_request for other 4xx responses', async () => {
      process.env.LONGTERMWIKI_SERVER_URL = 'http://localhost:19999';
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Not Found', { status: 404 }),
      );
      const result = await client.apiRequest('GET', '/api/test');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('bad_request');
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
