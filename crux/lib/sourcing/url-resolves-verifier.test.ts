/**
 * Tests for the url-resolves verifier (QUA-927).
 *
 * Mocks `globalThis.fetch` so individual tests can drive the verifier through
 * 2xx, 3xx, 4xx, 5xx, network errors, HEAD-not-allowed, and the Wikipedia
 * title-match path without touching the network.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  tryUrlResolvesVerify,
  probeUrlResolves,
  probeWikipediaUrl,
  extractWikipediaTitle,
} from './url-resolves-verifier.ts';
import type { VerifyItem, FactItemData } from './orchestrator-types.ts';

// ── Fetch mock plumbing ─────────────────────────────────────────────

interface MockResponse {
  status: number;
  /** Final URL after redirects (defaults to request URL). */
  finalUrl?: string;
  /** Body returned by GET. Ignored for HEAD. */
  body?: string;
  /**
   * If set, mark .body as null so readCappedText returns ''. Lets us simulate
   * a 200-OK Wikipedia response with no body (rare but possible).
   */
  noBody?: boolean;
}

interface MockBehavior {
  /** Hook: return a MockResponse, or `'throw'` to simulate a network error. */
  (url: string, method: string): MockResponse | 'throw';
}

let currentBehavior: MockBehavior = () => ({ status: 200 });

function setMockBehavior(b: MockBehavior): void {
  currentBehavior = b;
}

beforeEach(() => {
  // Default: every request returns 200. Tests override per-case.
  setMockBehavior(() => ({ status: 200 }));
});

vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const out = currentBehavior(url, method);
    if (out === 'throw') {
      throw new Error('mock network error');
    }
    const finalUrl = out.finalUrl ?? url;
    const body = out.body ?? '';
    // Build a real Response so .body / .text() / status all behave normally.
    const init2: ResponseInit = { status: out.status };
    const responseBody = out.noBody ? null : new Blob([body]);
    const response = new Response(responseBody, init2);
    // Response.url is read-only; override via Object.defineProperty so the
    // verifier sees the final-after-redirects URL like real fetch.
    Object.defineProperty(response, 'url', { value: finalUrl, configurable: true });
    return response;
  }),
);

// ── Test fixtures ───────────────────────────────────────────────────

function makeFactItem(overrides: Partial<FactItemData> = {}): VerifyItem {
  const data: FactItemData = {
    kind: 'fact',
    entity: { id: 'sid_test_anth', name: 'Anthropic', type: 'organization' } as FactItemData['entity'],
    fact: {
      id: 'f_url_001',
      propertyId: 'wikipedia-url',
      value: { type: 'text', value: 'https://en.wikipedia.org/wiki/Anthropic' },
      source: 'https://en.wikipedia.org/wiki/Anthropic',
    } as FactItemData['fact'],
    propertyName: 'Wikipedia',
    propertyId: 'wikipedia-url',
    formattedValue: 'https://en.wikipedia.org/wiki/Anthropic',
    rawValue: 'https://en.wikipedia.org/wiki/Anthropic',
    verifierKind: 'url-resolves',
    ...overrides,
  };
  return {
    kind: 'fact',
    id: `fact:${data.fact.id}`,
    description: `${data.entity.name} / ${data.propertyName} = ${data.formattedValue}`,
    entityType: data.entity.type ?? 'unknown',
    entityName: data.entity.name,
    priority: 1,
    sourceUrl: data.fact.source,
    neverVerified: true,
    data,
  };
}

// ── tryUrlResolvesVerify dispatch ──────────────────────────────────

describe('tryUrlResolvesVerify', () => {
  it('returns null when fact has no verifierKind', async () => {
    const item = makeFactItem({ verifierKind: undefined });
    const result = await tryUrlResolvesVerify(item);
    expect(result).toBeNull();
  });

  it('returns null for non-fact items', async () => {
    const item: VerifyItem = {
      kind: 'entity',
      id: 'entity:foo',
      description: 'foo',
      entityType: 'organization',
      entityName: 'Foo',
      priority: 1,
      neverVerified: true,
      data: { kind: 'entity', entity: { id: 'sid_foo', title: 'Foo', sources: [] } as never },
    };
    const result = await tryUrlResolvesVerify(item);
    expect(result).toBeNull();
  });

  it('returns unverifiable when fact value is not a URL', async () => {
    const item = makeFactItem({
      propertyId: 'github-profile',
      rawValue: 'just-a-username',
      formattedValue: 'just-a-username',
      verifierKind: 'url-resolves',
    });
    const result = await tryUrlResolvesVerify(item);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('unverifiable');
    expect(result!.checkerModel).toBe('url-resolves');
    expect(result!.reasoning).toContain('not a URL');
  });

  it('returns unverifiable when fact value is empty', async () => {
    const item = makeFactItem({
      propertyId: 'github-profile',
      rawValue: '',
      formattedValue: '',
    });
    const result = await tryUrlResolvesVerify(item);
    expect(result!.verdict).toBe('unverifiable');
    expect(result!.reasoning).toContain('not a URL');
  });

  it('returns unverifiable for non-http(s) URLs (e.g., ftp)', async () => {
    const item = makeFactItem({
      propertyId: 'github-profile',
      rawValue: 'ftp://example.com',
      formattedValue: 'ftp://example.com',
    });
    const result = await tryUrlResolvesVerify(item);
    expect(result!.verdict).toBe('unverifiable');
    expect(result!.reasoning).toContain('not a URL');
  });
});

// ── probeUrlResolves (non-Wikipedia path) ──────────────────────────

describe('probeUrlResolves', () => {
  it('confirms 2xx URLs', async () => {
    setMockBehavior(() => ({ status: 200 }));
    const result = await probeUrlResolves('https://github.com/anthropics');
    expect(result.verdict).toBe('confirmed');
    expect(result.confidence).toBe(0.95);
    expect(result.reasoning).toContain('HTTP 200');
  });

  it('contradicts 404', async () => {
    setMockBehavior(() => ({ status: 404 }));
    const result = await probeUrlResolves('https://github.com/dead-user-xyz');
    expect(result.verdict).toBe('contradicted');
    expect(result.confidence).toBe(0.95);
    expect(result.reasoning).toContain('HTTP 404');
  });

  it('contradicts 500-class server errors', async () => {
    setMockBehavior(() => ({ status: 503 }));
    const result = await probeUrlResolves('https://example.com');
    expect(result.verdict).toBe('contradicted');
    expect(result.reasoning).toContain('HTTP 503');
  });

  it('falls back to GET when HEAD returns 405', async () => {
    let firstCall = true;
    setMockBehavior((_url, method) => {
      if (method === 'HEAD' && firstCall) {
        firstCall = false;
        return { status: 405 };
      }
      // Fallback GET
      return { status: 200 };
    });
    const result = await probeUrlResolves('https://example.com/strict-server');
    expect(result.verdict).toBe('confirmed');
  });

  it('falls back to GET when HEAD returns 501', async () => {
    let firstCall = true;
    setMockBehavior((_url, method) => {
      if (method === 'HEAD' && firstCall) {
        firstCall = false;
        return { status: 501 };
      }
      return { status: 200 };
    });
    const result = await probeUrlResolves('https://example.com/no-head');
    expect(result.verdict).toBe('confirmed');
  });

  it('records the final URL after redirect', async () => {
    setMockBehavior(() => ({ status: 200, finalUrl: 'https://github.com/anthropic-ai' }));
    const result = await probeUrlResolves('https://github.com/anthropic');
    expect(result.verdict).toBe('confirmed');
    expect(result.finalUrl).toBe('https://github.com/anthropic-ai');
    expect(result.reasoning).toContain('redirected to');
  });

  it('returns unverifiable on network error', async () => {
    setMockBehavior(() => 'throw');
    const result = await probeUrlResolves('https://timeout.example.com');
    expect(result.verdict).toBe('unverifiable');
    expect(result.reasoning).toContain('network error');
  });
});

// ── probeWikipediaUrl ──────────────────────────────────────────────

describe('probeWikipediaUrl', () => {
  const wikipediaBody = (title: string) =>
    `<!DOCTYPE html><html><head><title>${title} - Wikipedia</title></head><body>...</body></html>`;

  it('confirms when title contains entity name', async () => {
    setMockBehavior(() => ({ status: 200, body: wikipediaBody('Anthropic') }));
    const result = await probeWikipediaUrl(
      'https://en.wikipedia.org/wiki/Anthropic',
      'Anthropic',
    );
    expect(result.verdict).toBe('confirmed');
    expect(result.pageTitle).toBe('Anthropic');
    expect(result.confidence).toBe(0.95);
  });

  it('confirms case-insensitively', async () => {
    setMockBehavior(() => ({ status: 200, body: wikipediaBody('Geoffrey Hinton') }));
    const result = await probeWikipediaUrl(
      'https://en.wikipedia.org/wiki/Geoffrey_Hinton',
      'geoffrey hinton',
    );
    expect(result.verdict).toBe('confirmed');
  });

  it('contradicts when title does not contain entity name', async () => {
    setMockBehavior(() => ({ status: 200, body: wikipediaBody('Disambiguation page') }));
    const result = await probeWikipediaUrl(
      'https://en.wikipedia.org/wiki/Anthropic',
      'Anthropic',
    );
    expect(result.verdict).toBe('contradicted');
    expect(result.pageTitle).toBe('Disambiguation page');
    expect(result.reasoning).toContain('does not contain');
  });

  it('contradicts on 404 (link rot)', async () => {
    setMockBehavior(() => ({ status: 404 }));
    const result = await probeWikipediaUrl(
      'https://en.wikipedia.org/wiki/Nonexistent',
      'Nonexistent',
    );
    expect(result.verdict).toBe('contradicted');
    expect(result.reasoning).toContain('link rot');
  });

  it('returns unverifiable on network error', async () => {
    setMockBehavior(() => 'throw');
    const result = await probeWikipediaUrl(
      'https://timeout.example.com',
      'Foo',
    );
    expect(result.verdict).toBe('unverifiable');
    expect(result.reasoning).toContain('network error');
  });

  it('confirms at lower confidence when title is unparseable', async () => {
    setMockBehavior(() => ({ status: 200, body: '<html><head></head><body>no title</body></html>' }));
    const result = await probeWikipediaUrl(
      'https://en.wikipedia.org/wiki/Anthropic',
      'Anthropic',
    );
    expect(result.verdict).toBe('confirmed');
    expect(result.confidence).toBe(0.7);
    expect(result.reasoning).toContain('not parseable');
  });
});

// ── extractWikipediaTitle ──────────────────────────────────────────

describe('extractWikipediaTitle', () => {
  it('strips the " - Wikipedia" suffix', () => {
    expect(extractWikipediaTitle('<title>Anthropic - Wikipedia</title>')).toBe('Anthropic');
  });

  it('strips an en-dash variant', () => {
    expect(extractWikipediaTitle('<title>Anthropic – Wikipedia</title>')).toBe('Anthropic');
  });

  it('decodes HTML entities', () => {
    expect(extractWikipediaTitle('<title>AT&amp;T - Wikipedia</title>')).toBe('AT&T');
  });

  it('returns null when no <title> tag', () => {
    expect(extractWikipediaTitle('<html><body>no head</body></html>')).toBeNull();
  });

  it('handles attributes on title tag', () => {
    expect(extractWikipediaTitle('<title id="x">Foo - Wikipedia</title>')).toBe('Foo');
  });

  it('returns null when title is empty after suffix strip', () => {
    expect(extractWikipediaTitle('<title> - Wikipedia</title>')).toBeNull();
  });
});

// ── End-to-end via tryUrlResolvesVerify ────────────────────────────

describe('tryUrlResolvesVerify (end-to-end)', () => {
  it('confirms a github-profile that resolves', async () => {
    setMockBehavior(() => ({ status: 200 }));
    const item = makeFactItem({
      propertyId: 'github-profile',
      rawValue: 'https://github.com/anthropics',
      formattedValue: 'https://github.com/anthropics',
    });
    const result = await tryUrlResolvesVerify(item);
    expect(result!.verdict).toBe('confirmed');
    expect(result!.checkerModel).toBe('url-resolves');
    expect(result!.sourceUrl).toBeTruthy();
  });

  it('contradicts a wikipedia-url whose article is the wrong topic', async () => {
    setMockBehavior(() => ({
      status: 200,
      body:
        '<html><head><title>Disambiguation - Wikipedia</title></head><body></body></html>',
    }));
    const item = makeFactItem(); // defaults to wikipedia-url for Anthropic
    const result = await tryUrlResolvesVerify(item);
    expect(result!.verdict).toBe('contradicted');
    expect(result!.extractedValue).toBe('Disambiguation');
  });

  it('contradicts a 404 google-scholar profile', async () => {
    setMockBehavior(() => ({ status: 404 }));
    const item = makeFactItem({
      propertyId: 'google-scholar',
      rawValue: 'https://scholar.google.com/citations?user=removed',
      formattedValue: 'https://scholar.google.com/citations?user=removed',
    });
    const result = await tryUrlResolvesVerify(item);
    expect(result!.verdict).toBe('contradicted');
  });

  it('returns unverifiable on persistent network failure', async () => {
    setMockBehavior(() => 'throw');
    const item = makeFactItem({
      propertyId: 'social-media',
      rawValue: 'https://x.com/anthropic',
      formattedValue: 'https://x.com/anthropic',
    });
    const result = await tryUrlResolvesVerify(item);
    expect(result!.verdict).toBe('unverifiable');
  });
});
