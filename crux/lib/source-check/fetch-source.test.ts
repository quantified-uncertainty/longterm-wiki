import { describe, it, expect } from 'vitest';
import { isPrivateHost, htmlToPlainText, fetchSourceContent } from './fetch-source.ts';

// ── isPrivateHost ─────────────────────────────────────────────────────

describe('isPrivateHost', () => {
  it('blocks localhost variants', () => {
    expect(isPrivateHost('localhost')).toBe(true);
    expect(isPrivateHost('127.0.0.1')).toBe(true);
    expect(isPrivateHost('[::1]')).toBe(true);
    expect(isPrivateHost('::1')).toBe(true);
    expect(isPrivateHost('0.0.0.0')).toBe(true);
  });

  it('blocks IPv4 private ranges', () => {
    expect(isPrivateHost('10.0.0.1')).toBe(true);
    expect(isPrivateHost('172.16.0.1')).toBe(true);
    expect(isPrivateHost('172.31.255.255')).toBe(true);
    expect(isPrivateHost('192.168.1.1')).toBe(true);
    expect(isPrivateHost('169.254.0.1')).toBe(true);
  });

  it('blocks IPv6 private/reserved ranges', () => {
    expect(isPrivateHost('fe80::1')).toBe(true);
    expect(isPrivateHost('fc00::1')).toBe(true);
    expect(isPrivateHost('fd12::1')).toBe(true);
  });

  it('blocks IPv4-mapped IPv6 addresses for private hosts', () => {
    expect(isPrivateHost('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateHost('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateHost('::ffff:192.168.1.1')).toBe(true);
    expect(isPrivateHost('::ffff:172.16.0.1')).toBe(true);
    expect(isPrivateHost('::ffff:169.254.0.1')).toBe(true);
  });

  it('blocks .local and .internal TLDs', () => {
    expect(isPrivateHost('myserver.local')).toBe(true);
    expect(isPrivateHost('db.internal')).toBe(true);
  });

  it('allows public hostnames', () => {
    expect(isPrivateHost('google.com')).toBe(false);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('example.org')).toBe(false);
    expect(isPrivateHost('2001:db8::1')).toBe(false);
  });
});

// ── htmlToPlainText ───────────────────────────────────────────────────

describe('htmlToPlainText', () => {
  it('removes script tags and their content', () => {
    const html = '<p>Hello</p><script>alert("xss")</script><p>World</p>';
    const text = htmlToPlainText(html);
    expect(text).not.toContain('alert');
    expect(text).toContain('Hello');
    expect(text).toContain('World');
  });

  it('removes style tags and their content', () => {
    const html = '<style>.foo { color: red; }</style><p>Content</p>';
    const text = htmlToPlainText(html);
    expect(text).not.toContain('color');
    expect(text).toContain('Content');
  });

  it('unescapes HTML entities', () => {
    const html = '&amp; &lt;tag&gt; &quot;quoted&quot; &#39;single&#39; &nbsp;space';
    const text = htmlToPlainText(html);
    expect(text).toContain('& <tag> "quoted" \'single\'');
  });

  it('collapses whitespace', () => {
    const html = '<p>Hello</p>   \n\n   <p>World</p>';
    const text = htmlToPlainText(html);
    // Should not have multiple consecutive spaces
    expect(text).not.toMatch(/\s{2,}/);
    expect(text).toContain('Hello');
    expect(text).toContain('World');
  });

  it('trims leading and trailing whitespace', () => {
    const html = '  <p>Hello</p>  ';
    const text = htmlToPlainText(html);
    expect(text).toBe('Hello');
  });

  it('handles empty input', () => {
    expect(htmlToPlainText('')).toBe('');
  });
});

// ── fetchSourceContent ────────────────────────────────────────────────

describe('fetchSourceContent', () => {
  it('rejects non-HTTPS URLs', async () => {
    const result = await fetchSourceContent('http://example.com/page');
    expect(result.content).toBeNull();
    expect(result.errorType).toBe('fetch_error');
    expect(result.errorMessage).toBe('Non-HTTPS URL');
  });

  it('rejects file:// URLs', async () => {
    const result = await fetchSourceContent('file:///etc/passwd');
    expect(result.content).toBeNull();
    expect(result.errorType).toBe('fetch_error');
    expect(result.errorMessage).toBe('Non-HTTPS URL');
  });

  it('blocks private hosts', async () => {
    const result = await fetchSourceContent('https://127.0.0.1/secret');
    expect(result.content).toBeNull();
    expect(result.errorType).toBe('access_denied');
    expect(result.errorMessage).toBe('Private/internal host blocked');
  });

  it('blocks IPv6 private hosts', async () => {
    const result = await fetchSourceContent('https://[::1]/secret');
    expect(result.content).toBeNull();
    expect(result.errorType).toBe('access_denied');
  });

  it('blocks unverifiable domains', async () => {
    const result = await fetchSourceContent('https://twitter.com/user/status/123');
    expect(result.content).toBeNull();
    expect(result.errorType).toBe('unverifiable_domain');
    expect(result.errorMessage).toBe('Domain blocks automated access');
  });

  it('returns error for invalid URL', async () => {
    const result = await fetchSourceContent('https://');
    expect(result.content).toBeNull();
    expect(result.errorType).toBe('fetch_error');
  });

  it('passes custom options through', async () => {
    // Verify that custom user agent and log prefix don't cause errors
    const result = await fetchSourceContent('http://example.com', {
      userAgent: 'TestAgent/1.0',
      logPrefix: '[test]',
      maxContentLength: 100,
      fetchTimeoutMs: 5000,
    });
    // Should still reject non-HTTPS
    expect(result.content).toBeNull();
    expect(result.errorType).toBe('fetch_error');
  });
});
