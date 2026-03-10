/**
 * Tests for paywall-detection.ts
 *
 * Covers: paywall signal detection, unverifiable domain detection,
 * and structured fetch error classification.
 */

import { describe, it, expect } from 'vitest';
import {
  detectPaywall,
  isUnverifiableDomain,
  classifyFetchError,
  PAYWALL_SIGNALS,
  UNVERIFIABLE_DOMAINS,
} from './paywall-detection.ts';

// ---------------------------------------------------------------------------
// detectPaywall
// ---------------------------------------------------------------------------

describe('detectPaywall', () => {
  it('returns false for empty content', () => {
    expect(detectPaywall('')).toBe(false);
  });

  it('returns false for normal content without paywall signals', () => {
    const content = 'This is a normal article about AI safety research. '.repeat(20);
    expect(detectPaywall(content)).toBe(false);
  });

  it('detects paywall in short content with one signal', () => {
    const content = 'Subscribe to read the full article. This premium content is locked.';
    expect(detectPaywall(content)).toBe(true);
  });

  it('detects paywall with "login required" signal in short content', () => {
    const content = 'Login required to access this resource.';
    expect(detectPaywall(content)).toBe(true);
  });

  it('requires two signals in longer content to avoid false positives', () => {
    // One signal in longer content should not trigger
    const longContent = 'A'.repeat(600) + ' subscribe to read ' + 'B'.repeat(600);
    expect(detectPaywall(longContent)).toBe(false);
  });

  it('detects paywall when two signals appear early in longer content', () => {
    const longContent = 'Subscribe to read this content is for subscribers ' + 'A'.repeat(2000);
    expect(detectPaywall(longContent)).toBe(true);
  });

  it('ignores paywall signals that appear late in longer content', () => {
    // Signals after the first 2000 chars should be ignored
    const longContent = 'A'.repeat(2500) + ' subscribe to read this content is for subscribers';
    expect(detectPaywall(longContent)).toBe(false);
  });

  it('is case-insensitive', () => {
    const content = 'SUBSCRIBE TO READ this article.';
    expect(detectPaywall(content)).toBe(true);
  });

  it('detects all known paywall signals individually in short content', () => {
    for (const signal of PAYWALL_SIGNALS) {
      expect(detectPaywall(signal)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// isUnverifiableDomain
// ---------------------------------------------------------------------------

describe('isUnverifiableDomain', () => {
  it('identifies Twitter/X domains', () => {
    expect(isUnverifiableDomain('https://twitter.com/user/status/123')).toBe(true);
    expect(isUnverifiableDomain('https://x.com/user/status/123')).toBe(true);
  });

  it('identifies LinkedIn', () => {
    expect(isUnverifiableDomain('https://www.linkedin.com/in/user')).toBe(true);
  });

  it('identifies Facebook', () => {
    expect(isUnverifiableDomain('https://facebook.com/page')).toBe(true);
  });

  it('identifies t.co short links', () => {
    expect(isUnverifiableDomain('https://t.co/abc123')).toBe(true);
  });

  it('identifies Instagram and TikTok', () => {
    expect(isUnverifiableDomain('https://instagram.com/user')).toBe(true);
    expect(isUnverifiableDomain('https://tiktok.com/@user')).toBe(true);
  });

  it('identifies subdomains of unverifiable domains', () => {
    expect(isUnverifiableDomain('https://mobile.twitter.com/user')).toBe(true);
  });

  it('does not flag regular domains', () => {
    expect(isUnverifiableDomain('https://example.com')).toBe(false);
    expect(isUnverifiableDomain('https://arxiv.org/abs/1234')).toBe(false);
    expect(isUnverifiableDomain('https://nytimes.com/article')).toBe(false);
  });

  it('strips www. prefix', () => {
    expect(isUnverifiableDomain('https://www.twitter.com/user')).toBe(true);
    expect(isUnverifiableDomain('https://www.example.com')).toBe(false);
  });

  it('handles invalid URLs gracefully', () => {
    expect(isUnverifiableDomain('not-a-url')).toBe(false);
    expect(isUnverifiableDomain('')).toBe(false);
  });

  it('covers all configured unverifiable domains', () => {
    for (const domain of UNVERIFIABLE_DOMAINS) {
      expect(isUnverifiableDomain(`https://${domain}/path`)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// classifyFetchError
// ---------------------------------------------------------------------------

describe('classifyFetchError', () => {
  it('returns null for successful fetches', () => {
    expect(classifyFetchError(200, null, 'Normal content here', 'https://example.com')).toBe(null);
  });

  it('detects unverifiable domains', () => {
    expect(classifyFetchError(200, null, 'content', 'https://twitter.com/user')).toBe('unverifiable_domain');
  });

  it('detects timeout errors', () => {
    expect(classifyFetchError(0, 'The operation was aborted', null, 'https://example.com')).toBe('timeout');
    expect(classifyFetchError(0, 'timeout exceeded', null, 'https://example.com')).toBe('timeout');
    expect(classifyFetchError(0, 'AbortError', null, 'https://example.com')).toBe('timeout');
  });

  it('detects access denied (401/403)', () => {
    expect(classifyFetchError(401, null, null, 'https://example.com')).toBe('access_denied');
    expect(classifyFetchError(403, null, null, 'https://example.com')).toBe('access_denied');
  });

  it('detects not found (404/410)', () => {
    expect(classifyFetchError(404, null, null, 'https://example.com')).toBe('not_found');
    expect(classifyFetchError(410, null, null, 'https://example.com')).toBe('not_found');
  });

  it('detects generic HTTP errors (4xx/5xx)', () => {
    expect(classifyFetchError(500, null, null, 'https://example.com')).toBe('fetch_error');
    expect(classifyFetchError(502, null, null, 'https://example.com')).toBe('fetch_error');
    expect(classifyFetchError(429, null, null, 'https://example.com')).toBe('fetch_error');
  });

  it('detects paywalled content', () => {
    const paywallContent = 'Subscribe to read the full article. Login required.';
    expect(classifyFetchError(200, null, paywallContent, 'https://example.com')).toBe('paywall');
  });

  it('detects generic fetch errors with no HTTP response', () => {
    expect(classifyFetchError(0, 'ECONNREFUSED', null, 'https://example.com')).toBe('fetch_error');
  });

  it('prioritizes unverifiable domain over other errors', () => {
    // Even if there's a timeout, unverifiable domain takes precedence
    expect(classifyFetchError(0, 'timeout', null, 'https://twitter.com/user')).toBe('unverifiable_domain');
  });

  it('prioritizes timeout over HTTP errors', () => {
    // timeout error message takes precedence over HTTP status
    expect(classifyFetchError(500, 'abort', null, 'https://example.com')).toBe('timeout');
  });
});
