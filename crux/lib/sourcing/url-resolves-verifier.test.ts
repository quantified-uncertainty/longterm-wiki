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
  decodeHtmlEntities,
  titleContainsEntityName,
  rejectIfInternalHost,
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
    expect(result!.reasoning).toContain('not an http(s) URL');
  });

  it('returns unverifiable when fact value is empty', async () => {
    const item = makeFactItem({
      propertyId: 'github-profile',
      rawValue: '',
      formattedValue: '',
    });
    const result = await tryUrlResolvesVerify(item);
    expect(result!.verdict).toBe('unverifiable');
    expect(result!.reasoning).toContain('not an http(s) URL');
  });

  it('returns unverifiable when rawValue is missing (no formattedValue fallback)', async () => {
    // formattedValue can carry display formatting (units, parens), so we
    // refuse to fall back to it. rawValue must be present.
    const item = makeFactItem({
      propertyId: 'github-profile',
      rawValue: undefined,
      formattedValue: 'https://github.com/anthropics',
    });
    const result = await tryUrlResolvesVerify(item);
    expect(result!.verdict).toBe('unverifiable');
    expect(result!.reasoning).toContain('not an http(s) URL');
  });

  it('returns unverifiable for non-http(s) URLs (e.g., ftp)', async () => {
    const item = makeFactItem({
      propertyId: 'github-profile',
      rawValue: 'ftp://example.com',
      formattedValue: 'ftp://example.com',
    });
    const result = await tryUrlResolvesVerify(item);
    expect(result!.verdict).toBe('unverifiable');
    expect(result!.reasoning).toContain('not an http(s) URL');
  });

  it('returns unverifiable for URLs with embedded credentials', async () => {
    const item = makeFactItem({
      propertyId: 'github-profile',
      rawValue: 'https://user:pass@github.com/anthropics',
      formattedValue: 'https://user:pass@github.com/anthropics',
    });
    const result = await tryUrlResolvesVerify(item);
    expect(result!.verdict).toBe('unverifiable');
    expect(result!.reasoning).toContain('not an http(s) URL');
  });

  it('SSRF: rejects loopback URLs without making any request', async () => {
    let fetchCalled = false;
    setMockBehavior(() => {
      fetchCalled = true;
      return { status: 200 };
    });
    const item = makeFactItem({
      propertyId: 'github-profile',
      rawValue: 'http://127.0.0.1/admin',
      formattedValue: 'http://127.0.0.1/admin',
    });
    const result = await tryUrlResolvesVerify(item);
    expect(fetchCalled).toBe(false);
    expect(result!.verdict).toBe('unverifiable');
    expect(result!.reasoning).toMatch(/loopback|internal/);
  });

  it('SSRF: rejects RFC1918 private addresses', async () => {
    const cases = [
      'http://10.0.0.1/',
      'http://192.168.1.1/',
      'http://172.16.0.1/',
      'http://172.31.255.255/',
    ];
    for (const url of cases) {
      const item = makeFactItem({
        propertyId: 'github-profile',
        rawValue: url,
        formattedValue: url,
      });
      const result = await tryUrlResolvesVerify(item);
      expect(result!.verdict, `${url} should be rejected`).toBe('unverifiable');
      expect(result!.reasoning).toMatch(/private|loopback|link-local|internal/);
    }
  });

  it('SSRF: rejects link-local 169.254/16', async () => {
    const item = makeFactItem({
      propertyId: 'github-profile',
      rawValue: 'http://169.254.169.254/latest/meta-data/',
      formattedValue: 'http://169.254.169.254/latest/meta-data/',
    });
    const result = await tryUrlResolvesVerify(item);
    expect(result!.verdict).toBe('unverifiable');
    expect(result!.reasoning).toContain('link-local');
  });

  it('SSRF: rejects localhost and .internal/.local hostnames', async () => {
    const cases = [
      'http://localhost/',
      'http://wiki-server.internal/',
      'http://printer.local/',
    ];
    for (const url of cases) {
      const item = makeFactItem({
        propertyId: 'github-profile',
        rawValue: url,
        formattedValue: url,
      });
      const result = await tryUrlResolvesVerify(item);
      expect(result!.verdict, `${url} should be rejected`).toBe('unverifiable');
    }
  });

  it('SSRF: rejects IPv6 loopback ::1', async () => {
    const item = makeFactItem({
      propertyId: 'github-profile',
      rawValue: 'http://[::1]/',
      formattedValue: 'http://[::1]/',
    });
    const result = await tryUrlResolvesVerify(item);
    expect(result!.verdict).toBe('unverifiable');
    expect(result!.reasoning).toMatch(/loopback IPv6/);
  });

  it('SSRF: detects redirect to internal host and downgrades verdict', async () => {
    setMockBehavior(() => ({
      status: 200,
      finalUrl: 'http://10.0.0.1/internal-api',
    }));
    const item = makeFactItem({
      propertyId: 'github-profile',
      rawValue: 'https://link.example.com/redirect',
      formattedValue: 'https://link.example.com/redirect',
    });
    const result = await tryUrlResolvesVerify(item);
    expect(result!.verdict).toBe('unverifiable');
    expect(result!.reasoning).toContain('internal host');
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

  it('does NOT confirm when entity name is a substring of a different word (word-boundary)', async () => {
    // QUA-927 review fix: "Foo" should not match "Foobar - Wikipedia"
    setMockBehavior(() => ({ status: 200, body: wikipediaBody('Foobar') }));
    const result = await probeWikipediaUrl(
      'https://en.wikipedia.org/wiki/Foo',
      'Foo',
    );
    expect(result.verdict).toBe('contradicted');
  });

  it('does NOT confirm short acronym matching part of a larger word', async () => {
    // "AI" matching "AIDS" or "Aircraft" was the worst-case substring trap
    setMockBehavior(() => ({ status: 200, body: wikipediaBody('Aircraft') }));
    const result = await probeWikipediaUrl(
      'https://en.wikipedia.org/wiki/AI',
      'AI',
    );
    expect(result.verdict).toBe('contradicted');
  });

  it('confirms acronym match at a word boundary', async () => {
    // "AI" should still match "AI safety - Wikipedia" — whole word
    setMockBehavior(() => ({ status: 200, body: wikipediaBody('AI safety') }));
    const result = await probeWikipediaUrl(
      'https://en.wikipedia.org/wiki/AI_safety',
      'AI',
    );
    expect(result.verdict).toBe('confirmed');
  });

  it('confirms multi-word entity at word boundaries', async () => {
    setMockBehavior(() => ({ status: 200, body: wikipediaBody('Geoffrey Hinton (researcher)') }));
    const result = await probeWikipediaUrl(
      'https://en.wikipedia.org/wiki/Geoffrey_Hinton',
      'Geoffrey Hinton',
    );
    expect(result.verdict).toBe('confirmed');
  });

  it('confirms across hyphen/space differences (normalized)', async () => {
    // Title may use a hyphen where entity name has a space (or vice versa).
    setMockBehavior(() => ({ status: 200, body: wikipediaBody('Foo-Bar Inc') }));
    const result = await probeWikipediaUrl(
      'https://en.wikipedia.org/wiki/Foo-Bar',
      'Foo Bar',
    );
    expect(result.verdict).toBe('confirmed');
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

// ── decodeHtmlEntities ─────────────────────────────────────────────

describe('decodeHtmlEntities', () => {
  it('decodes named entities used by Wikipedia', () => {
    expect(decodeHtmlEntities('AT&amp;T')).toBe('AT&T');
    expect(decodeHtmlEntities('a &lt;b&gt; c')).toBe('a <b> c');
    expect(decodeHtmlEntities('&quot;Hi&quot;')).toBe('"Hi"');
    expect(decodeHtmlEntities("don&#39;t")).toBe("don't");
    expect(decodeHtmlEntities("don&apos;t")).toBe("don't");
    expect(decodeHtmlEntities('a&nbsp;b')).toBe('a b');
    expect(decodeHtmlEntities('Foo &mdash; Bar')).toBe('Foo — Bar');
    expect(decodeHtmlEntities('&copy; 2026')).toBe('© 2026');
  });

  it('decodes decimal numeric entities (&#NN;)', () => {
    // Citroën uses &#235; for "ë"
    expect(decodeHtmlEntities('Citro&#235;n')).toBe('Citroën');
    // São Paulo uses &#227; for "ã"
    expect(decodeHtmlEntities('S&#227;o Paulo')).toBe('São Paulo');
  });

  it('decodes hex numeric entities (&#xNN;)', () => {
    expect(decodeHtmlEntities('Citro&#xeb;n')).toBe('Citroën');
    expect(decodeHtmlEntities('S&#xE3;o Paulo')).toBe('São Paulo');
  });

  it('decodes &amp; LAST so &amp;lt; becomes &lt; not <', () => {
    expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;');
  });

  it('returns input unchanged when no entities present', () => {
    expect(decodeHtmlEntities('plain text')).toBe('plain text');
  });

  it('ignores invalid numeric entities (out of unicode range)', () => {
    expect(decodeHtmlEntities('&#9999999999;')).toBe('');
    expect(decodeHtmlEntities('&#x110000;')).toBe('');
  });

  it('Wikipedia title with numeric entity end-to-end', () => {
    expect(extractWikipediaTitle('<title>Citro&#235;n - Wikipedia</title>')).toBe('Citroën');
  });
});

// ── titleContainsEntityName ────────────────────────────────────────

describe('titleContainsEntityName', () => {
  it('matches whole-word at start, middle, end', () => {
    expect(titleContainsEntityName('Anthropic - Wikipedia', 'Anthropic')).toBe(true);
    expect(titleContainsEntityName('History of Anthropic Inc', 'Anthropic')).toBe(true);
    expect(titleContainsEntityName('Founders of Anthropic', 'Anthropic')).toBe(true);
  });

  it('rejects substring-of-larger-word', () => {
    expect(titleContainsEntityName('Foobar', 'Foo')).toBe(false);
    expect(titleContainsEntityName('Aircraft', 'AI')).toBe(false);
    expect(titleContainsEntityName('OpenSSL Project', 'Open')).toBe(false);
  });

  it('case-insensitive', () => {
    expect(titleContainsEntityName('Anthropic Inc', 'ANTHROPIC')).toBe(true);
    expect(titleContainsEntityName('ANTHROPIC INC', 'anthropic')).toBe(true);
  });

  it('returns false on empty input', () => {
    expect(titleContainsEntityName('', 'Anthropic')).toBe(false);
    expect(titleContainsEntityName('Anthropic', '')).toBe(false);
  });

  it('matches across hyphen/space punctuation differences', () => {
    // hyphens, periods, parens collapse to spaces — words still align as tokens
    expect(titleContainsEntityName('Foo-Bar Inc', 'Foo Bar')).toBe(true);
    expect(titleContainsEntityName('Yann Lecun', 'Yann LeCun')).toBe(true);
  });
});

// ── rejectIfInternalHost ───────────────────────────────────────────

describe('rejectIfInternalHost', () => {
  it('accepts public URLs', () => {
    expect(rejectIfInternalHost('https://en.wikipedia.org/wiki/Foo')).toBeNull();
    expect(rejectIfInternalHost('https://github.com/anthropics')).toBeNull();
    expect(rejectIfInternalHost('https://scholar.google.com/citations')).toBeNull();
  });

  it('rejects loopback IPv4', () => {
    expect(rejectIfInternalHost('http://127.0.0.1/')).toContain('loopback');
    expect(rejectIfInternalHost('http://127.255.255.254/')).toContain('loopback');
  });

  it('rejects 10/8', () => {
    expect(rejectIfInternalHost('http://10.0.0.1/')).toContain('10/8');
    expect(rejectIfInternalHost('http://10.255.255.255/')).toContain('10/8');
  });

  it('rejects 172.16/12', () => {
    expect(rejectIfInternalHost('http://172.16.0.1/')).toContain('172.16/12');
    expect(rejectIfInternalHost('http://172.31.255.255/')).toContain('172.16/12');
  });

  it('accepts 172.32+ (outside private range)', () => {
    expect(rejectIfInternalHost('http://172.32.0.1/')).toBeNull();
    expect(rejectIfInternalHost('http://172.15.0.1/')).toBeNull();
  });

  it('rejects 192.168/16', () => {
    expect(rejectIfInternalHost('http://192.168.1.1/')).toContain('192.168/16');
  });

  it('rejects 169.254/16 (link-local / AWS metadata)', () => {
    expect(rejectIfInternalHost('http://169.254.169.254/')).toContain('link-local');
  });

  it('rejects CGNAT 100.64-127', () => {
    expect(rejectIfInternalHost('http://100.64.0.1/')).toContain('CGNAT');
    expect(rejectIfInternalHost('http://100.127.255.255/')).toContain('CGNAT');
  });

  it('rejects 0.0.0.0', () => {
    expect(rejectIfInternalHost('http://0.0.0.0/')).toContain('null route');
  });

  it('rejects localhost', () => {
    expect(rejectIfInternalHost('http://localhost/')).toContain('local-only');
    expect(rejectIfInternalHost('http://api.localhost/')).toContain('local-only');
  });

  it('rejects .internal/.local/.lan TLDs', () => {
    expect(rejectIfInternalHost('http://wiki-server.internal/')).toContain('internal-only');
    expect(rejectIfInternalHost('http://printer.local/')).toContain('internal-only');
    expect(rejectIfInternalHost('http://router.lan/')).toContain('internal-only');
  });

  it('rejects IPv6 loopback ::1', () => {
    expect(rejectIfInternalHost('http://[::1]/')).toContain('loopback IPv6');
  });

  it('rejects IPv6 link-local fe80::', () => {
    expect(rejectIfInternalHost('http://[fe80::1]/')).toContain('link-local IPv6');
  });

  it('rejects IPv6 unique-local fc00::/7', () => {
    expect(rejectIfInternalHost('http://[fc00::1]/')).toContain('unique-local IPv6');
    expect(rejectIfInternalHost('http://[fd00::1]/')).toContain('unique-local IPv6');
  });

  it('rejects IPv4-mapped IPv6 of internal address', () => {
    const r1 = rejectIfInternalHost('http://[::ffff:127.0.0.1]/');
    const r2 = rejectIfInternalHost('http://[::ffff:10.0.0.1]/');
    expect(r1).not.toBeNull();
    expect(r1).toMatch(/loopback|IPv4-mapped/);
    expect(r2).not.toBeNull();
    expect(r2).toMatch(/private|IPv4-mapped/);
  });

  it('rejects unsupported protocols', () => {
    expect(rejectIfInternalHost('ftp://example.com/')).toContain('unsupported protocol');
    expect(rejectIfInternalHost('file:///etc/passwd')).toContain('unsupported protocol');
  });

  it('rejects unparseable URLs', () => {
    expect(rejectIfInternalHost('not a url')).toContain('unparseable');
  });
});
