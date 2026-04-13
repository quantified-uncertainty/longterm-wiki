/**
 * Tests for url-quality URL classifier helpers.
 *
 * Phase 2 of QUA-113 / Discussion #4221. Originally lived inline in
 * `crux/commands/sourcing-audit-urls.test.ts` (Phase 1, PR #4222) — moved here
 * when the helpers were extracted to a shared module.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyByUrl,
  normalizeUrlForJoin,
  extractHost,
  FLAG_THRESHOLD,
  FAST_PATH_THRESHOLD,
} from './url-quality.ts';

describe('classifyByUrl', () => {
  // ── Obvious homepages ──
  it.each([
    'https://example.com',
    'https://example.com/',
    'http://example.com',
    'https://www.example.com',
    'https://example.com/?utm_source=x',  // root with tracking params still homepage
  ])('classifies bare/root domain as homepage: %s', (url) => {
    const r = classifyByUrl(url);
    expect(r.purpose).toBe('homepage');
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it.each([
    'https://example.com/about',
    'https://example.com/about/',
    'https://example.com/about-us',
    'https://example.com/contact',
    'https://example.com/home.html',
    'https://example.com/index.html',
    'https://example.com/index',
  ])('classifies known homepage-adjacent path as homepage: %s', (url) => {
    const r = classifyByUrl(url);
    expect(r.purpose).toBe('homepage');
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  // ── NOT homepages ──
  it.each([
    'https://example.com/blog/2024/my-post',
    'https://example.com/team/jane-doe',
    'https://example.com/docs/api/reference',
    'https://example.com/products/widget-2000',
  ])('classifies deep paths as NOT homepage: %s', (url) => {
    const r = classifyByUrl(url);
    expect(r.purpose).toBeNull();
    expect(r.confidence).toBeLessThan(0.5);
  });

  it('classifies PDFs as never homepage regardless of depth', () => {
    expect(classifyByUrl('https://example.com/report.pdf').purpose).toBeNull();
    expect(classifyByUrl('https://example.com/reports/annual/2024.PDF').purpose).toBeNull();
    const r = classifyByUrl('https://example.com/doc.pdf');
    expect(r.purpose).toBeNull();
    expect(r.reasons).toContain('pdf');
  });

  it('classifies URLs with data-like query params as NOT homepage', () => {
    expect(classifyByUrl('https://example.com/?id=42').purpose).toBeNull();
    expect(classifyByUrl('https://youtube.com/?v=abc123').purpose).toBeNull();
    expect(classifyByUrl('https://example.com/search?q=foo').purpose).toBeNull();
  });

  it('does NOT classify URL with utm_ params alone as non-homepage', () => {
    expect(classifyByUrl('https://example.com/?utm_source=x&utm_medium=y').purpose).toBe('homepage');
  });

  it('treats meaningful fragments (deep anchors) as not homepage', () => {
    expect(classifyByUrl('https://twitter.com/status#1234567890').purpose).toBeNull();
    expect(classifyByUrl('https://example.com/#deep-anchor-ref').purpose).toBeNull();
  });

  it('ignores short/common fragments like #top', () => {
    expect(classifyByUrl('https://example.com/#top').purpose).toBe('homepage');
    expect(classifyByUrl('https://example.com/#').purpose).toBe('homepage');
  });

  it('returns reason=query-data-param for data-like query params', () => {
    const r = classifyByUrl('https://example.com/?id=42');
    expect(r.reasons).toContain('query-data-param');
  });

  it('is case-insensitive for homepage paths', () => {
    expect(classifyByUrl('https://example.com/ABOUT').purpose).toBe('homepage');
    expect(classifyByUrl('https://example.com/Index.HTML').purpose).toBe('homepage');
  });

  it('returns confidence 0 with reason=unparseable for bad input', () => {
    const r = classifyByUrl('not a url');
    expect(r.confidence).toBe(0);
    expect(r.reasons).toContain('unparseable');
  });

  it('handles IPv6 hosts without crashing', () => {
    const r = classifyByUrl('http://[::1]/');
    expect(r.purpose).toBe('homepage');
  });

  it('ignores userinfo in URL', () => {
    const r = classifyByUrl('https://user:pass@example.com/');
    expect(r.purpose).toBe('homepage');
  });

  // ── Wayback-prefixed ──
  it('unwraps Wayback URLs and classifies the inner URL', () => {
    const r1 = classifyByUrl('https://web.archive.org/web/20240101000000/https://example.com/');
    expect(r1.purpose).toBe('homepage');
    expect(r1.reasons).toContain('wayback-wrapped');

    const r2 = classifyByUrl('https://web.archive.org/web/20240101000000/https://example.com/docs/api/v2');
    expect(r2.purpose).toBeNull();
  });

  it('handles Wayback URLs without inner scheme', () => {
    const r = classifyByUrl('https://web.archive.org/web/20240101000000/example.com/');
    expect(r.purpose).toBe('homepage');
  });

  // ── URL shorteners ──
  it.each([
    'https://bit.ly/abc123',
    'https://t.co/shortcode',
    'https://tinyurl.com/xyz',
    'https://goo.gl/abc',
  ])('refuses to classify URL shorteners: %s', (url) => {
    const r = classifyByUrl(url);
    expect(r.purpose).toBeNull();
    expect(r.reasons).toContain('shortener');
  });

  // ── Malformed / unusual ──
  it('handles unparseable URLs gracefully', () => {
    expect(classifyByUrl('not a url').purpose).toBeNull();
    expect(classifyByUrl('').purpose).toBeNull();
    expect(classifyByUrl('http://').purpose).toBeNull();
  });

  it('skips non-http(s) schemes', () => {
    expect(classifyByUrl('mailto:foo@example.com').reasons).toContain('non-http-scheme');
    expect(classifyByUrl('file:///etc/passwd').reasons).toContain('non-http-scheme');
    expect(classifyByUrl('ftp://example.com/').reasons).toContain('non-http-scheme');
  });

  it('is case-insensitive for host', () => {
    const a = classifyByUrl('https://EXAMPLE.com/');
    const b = classifyByUrl('https://example.com/');
    expect(a.purpose).toBe(b.purpose);
  });

  // ── Threshold semantics — important for fast-path callers ──
  it('flags bare-domain confidence ≥ FAST_PATH_THRESHOLD (so callers can skip LLM)', () => {
    const r = classifyByUrl('https://example.com/');
    expect(r.purpose).toBe('homepage');
    expect(r.confidence).toBeGreaterThanOrEqual(FAST_PATH_THRESHOLD);
  });

  it('flags /about-style paths at exactly FAST_PATH_THRESHOLD (≥ FLAG, ≥ FAST_PATH)', () => {
    const r = classifyByUrl('https://example.com/about');
    expect(r.purpose).toBe('homepage');
    expect(r.confidence).toBeGreaterThanOrEqual(FLAG_THRESHOLD);
    expect(r.confidence).toBeGreaterThanOrEqual(FAST_PATH_THRESHOLD);
  });

  it('does NOT trip the FAST_PATH for ambiguous depth-1 paths', () => {
    const r = classifyByUrl('https://example.com/something');
    expect(r.confidence).toBeLessThan(FAST_PATH_THRESHOLD);
  });
});

describe('normalizeUrlForJoin', () => {
  it('strips trailing slash from non-root paths', () => {
    expect(normalizeUrlForJoin('https://example.com/foo/')).toBe('https://example.com/foo');
    expect(normalizeUrlForJoin('https://example.com/foo')).toBe('https://example.com/foo');
  });

  it('keeps root path (empty, not a trailing slash)', () => {
    expect(normalizeUrlForJoin('https://example.com/')).toBe('https://example.com');
    expect(normalizeUrlForJoin('https://example.com')).toBe('https://example.com');
  });

  it('strips www. prefix', () => {
    expect(normalizeUrlForJoin('https://www.example.com/foo')).toBe('https://example.com/foo');
  });

  it('lowercases host but preserves path case', () => {
    expect(normalizeUrlForJoin('https://EXAMPLE.com/FooBar')).toBe('https://example.com/FooBar');
  });

  it('strips fragment', () => {
    expect(normalizeUrlForJoin('https://example.com/foo#section')).toBe('https://example.com/foo');
  });

  it('strips common tracking params', () => {
    expect(normalizeUrlForJoin('https://example.com/?utm_source=x&utm_campaign=y'))
      .toBe('https://example.com');
    expect(normalizeUrlForJoin('https://example.com/foo?fbclid=x&id=42'))
      .toBe('https://example.com/foo?id=42');
    expect(normalizeUrlForJoin('https://example.com/?gclid=abc&msclkid=xyz'))
      .toBe('https://example.com');
  });

  it('preserves meaningful query params', () => {
    expect(normalizeUrlForJoin('https://example.com/search?q=foo&page=2'))
      .toBe('https://example.com/search?q=foo&page=2');
  });

  it('drops default ports', () => {
    expect(normalizeUrlForJoin('https://example.com:443/foo')).toBe('https://example.com/foo');
    expect(normalizeUrlForJoin('http://example.com:80/foo')).toBe('http://example.com/foo');
  });

  it('preserves non-default ports', () => {
    expect(normalizeUrlForJoin('https://example.com:8443/foo')).toBe('https://example.com:8443/foo');
  });

  it('falls back to lowercased raw string for unparseable URLs', () => {
    expect(normalizeUrlForJoin('not a url')).toBe('not a url');
    expect(normalizeUrlForJoin('  GARBAGE  ')).toBe('garbage');
  });
});

describe('extractHost', () => {
  it('returns lowercased hostname without www', () => {
    expect(extractHost('https://www.EXAMPLE.com/foo')).toBe('example.com');
    expect(extractHost('https://example.com')).toBe('example.com');
    expect(extractHost('http://subdomain.example.com/')).toBe('subdomain.example.com');
  });

  it('returns sentinel for invalid URLs', () => {
    expect(extractHost('not a url')).toBe('(invalid-url)');
    expect(extractHost('')).toBe('(invalid-url)');
  });
});
