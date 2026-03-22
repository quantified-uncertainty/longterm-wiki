/**
 * Tests for source-fetcher.ts
 */
import { describe, it, expect } from 'vitest';
import { isPrivateHost, htmlToText } from './source-fetcher.ts';

describe('isPrivateHost', () => {
  it('blocks localhost', () => {
    expect(isPrivateHost('localhost')).toBe(true);
  });

  it('blocks 127.0.0.1', () => {
    expect(isPrivateHost('127.0.0.1')).toBe(true);
  });

  it('blocks IPv6 loopback', () => {
    expect(isPrivateHost('[::1]')).toBe(true);
    expect(isPrivateHost('::1')).toBe(true);
  });

  it('blocks 0.0.0.0', () => {
    expect(isPrivateHost('0.0.0.0')).toBe(true);
  });

  it('blocks .local domains', () => {
    expect(isPrivateHost('myhost.local')).toBe(true);
  });

  it('blocks .internal domains', () => {
    expect(isPrivateHost('server.internal')).toBe(true);
  });

  it('blocks 10.x.x.x range', () => {
    expect(isPrivateHost('10.0.0.1')).toBe(true);
    expect(isPrivateHost('10.255.255.255')).toBe(true);
  });

  it('blocks 172.16-31.x.x range', () => {
    expect(isPrivateHost('172.16.0.1')).toBe(true);
    expect(isPrivateHost('172.31.255.255')).toBe(true);
  });

  it('does not block 172.32.x.x', () => {
    expect(isPrivateHost('172.32.0.1')).toBe(false);
  });

  it('blocks 192.168.x.x range', () => {
    expect(isPrivateHost('192.168.1.1')).toBe(true);
  });

  it('blocks link-local 169.254.x.x', () => {
    expect(isPrivateHost('169.254.1.1')).toBe(true);
  });

  it('blocks IPv4-mapped IPv6 private addresses', () => {
    expect(isPrivateHost('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateHost('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateHost('::ffff:192.168.1.1')).toBe(true);
  });

  it('allows public hosts', () => {
    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateHost('github.com')).toBe(false);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
  });

  it('blocks IPv6 link-local (fe80:)', () => {
    expect(isPrivateHost('fe80::1')).toBe(true);
  });

  it('blocks IPv6 unique local (fc/fd)', () => {
    expect(isPrivateHost('fc00::1')).toBe(true);
    expect(isPrivateHost('fd12::1')).toBe(true);
  });
});

describe('htmlToText', () => {
  it('strips script and style tags with content', () => {
    const html = '<p>Hello</p><script>alert("xss")</script><style>.x{color:red}</style><p>World</p>';
    const text = htmlToText(html);
    expect(text).toBe('Hello World');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color');
  });

  it('strips HTML tags', () => {
    const html = '<h1>Title</h1><p>Paragraph <b>bold</b></p>';
    expect(htmlToText(html)).toBe('Title Paragraph bold');
  });

  it('decodes HTML entities', () => {
    const html = '&amp; &lt; &gt; &quot; &#39; &nbsp;';
    expect(htmlToText(html)).toBe('& < > " \'');
  });

  it('collapses whitespace', () => {
    const html = '<p>Hello   \n\n   World</p>';
    expect(htmlToText(html)).toBe('Hello World');
  });

  it('handles empty string', () => {
    expect(htmlToText('')).toBe('');
  });

  it('handles plain text (no HTML)', () => {
    expect(htmlToText('Just plain text')).toBe('Just plain text');
  });
});
