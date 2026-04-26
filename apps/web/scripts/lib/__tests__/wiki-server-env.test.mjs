import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  findSlotFromAncestors,
  getEnvPrefix,
  getEnv,
  getServerUrl,
  getApiKey,
} from '../wiki-server-env.mjs';

let savedEnv;

beforeEach(() => {
  savedEnv = {
    LONGTERMWIKI_SERVER_URL: process.env.LONGTERMWIKI_SERVER_URL,
    LONGTERMWIKI_SERVER_API_KEY: process.env.LONGTERMWIKI_SERVER_API_KEY,
    PROD_LONGTERMWIKI_SERVER_URL: process.env.PROD_LONGTERMWIKI_SERVER_URL,
    PROD_LONGTERMWIKI_SERVER_API_KEY: process.env.PROD_LONGTERMWIKI_SERVER_API_KEY,
    WIKI_SERVER_ENV: process.env.WIKI_SERVER_ENV,
  };
  delete process.env.LONGTERMWIKI_SERVER_URL;
  delete process.env.LONGTERMWIKI_SERVER_API_KEY;
  delete process.env.PROD_LONGTERMWIKI_SERVER_URL;
  delete process.env.PROD_LONGTERMWIKI_SERVER_API_KEY;
  // Default to "local" so tests are hermetic regardless of where they run
  // (cwd-based slot auto-detect would otherwise leak in from real slots).
  process.env.WIKI_SERVER_ENV = 'local';
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('findSlotFromAncestors', () => {
  it('returns slot number when cwd is inside an a<N> directory', () => {
    expect(findSlotFromAncestors('/Users/x/lw/a3/apps/web')).toBe(3);
    expect(findSlotFromAncestors('/Users/x/lw/a17')).toBe(17);
  });

  it('returns null when no ancestor matches a<N> pattern', () => {
    expect(findSlotFromAncestors('/Users/x/lw/main')).toBeNull();
    expect(findSlotFromAncestors('/Users/x/lw/coord')).toBeNull();
    expect(findSlotFromAncestors('/Users/x/Documents/code')).toBeNull();
  });

  it('rejects non-numeric a<X> directories', () => {
    expect(findSlotFromAncestors('/Users/x/lw/abc')).toBeNull();
    expect(findSlotFromAncestors('/Users/x/lw/a1b')).toBeNull();
  });

  it('returns null at the filesystem root', () => {
    expect(findSlotFromAncestors('/')).toBeNull();
  });
});

describe('getEnvPrefix', () => {
  it('returns PROD_ when WIKI_SERVER_ENV=prod', () => {
    process.env.WIKI_SERVER_ENV = 'prod';
    expect(getEnvPrefix()).toBe('PROD_');
  });

  it('returns PROD_ when WIKI_SERVER_ENV=production', () => {
    process.env.WIKI_SERVER_ENV = 'production';
    expect(getEnvPrefix()).toBe('PROD_');
  });

  it('returns empty string when WIKI_SERVER_ENV=local', () => {
    process.env.WIKI_SERVER_ENV = 'local';
    expect(getEnvPrefix()).toBe('');
  });

  it('returns empty string when WIKI_SERVER_ENV=dev', () => {
    process.env.WIKI_SERVER_ENV = 'dev';
    expect(getEnvPrefix()).toBe('');
  });

  it('returns empty string when WIKI_SERVER_ENV is set to an unknown value', () => {
    process.env.WIKI_SERVER_ENV = 'staging';
    expect(getEnvPrefix()).toBe('');
  });
});

describe('getEnv / getServerUrl / getApiKey', () => {
  it('reads the unprefixed var by default', () => {
    process.env.LONGTERMWIKI_SERVER_URL = 'http://localhost:3130';
    expect(getServerUrl()).toBe('http://localhost:3130');
  });

  it('reads the PROD_-prefixed var when WIKI_SERVER_ENV=prod', () => {
    process.env.WIKI_SERVER_ENV = 'prod';
    process.env.LONGTERMWIKI_SERVER_URL = 'http://localhost:3130';
    process.env.PROD_LONGTERMWIKI_SERVER_URL = 'https://prod';
    expect(getServerUrl()).toBe('https://prod');
  });

  it('returns empty string when the relevant var is unset', () => {
    expect(getServerUrl()).toBe('');
    expect(getApiKey()).toBe('');
    expect(getEnv('LONGTERMWIKI_SERVER_URL')).toBe('');
  });

  it('respects WIKI_SERVER_ENV=local even when PROD_ vars are set', () => {
    process.env.WIKI_SERVER_ENV = 'local';
    process.env.PROD_LONGTERMWIKI_SERVER_URL = 'https://prod';
    expect(getServerUrl()).toBe('');
  });
});
