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
    // Shared htmlToText preserves paragraph structure via newlines
    expect(text).toContain('Hello');
    expect(text).toContain('World');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color');
  });

  it('strips HTML tags and preserves paragraph structure', () => {
    const html = '<h1>Title</h1><p>Paragraph <b>bold</b></p>';
    const text = htmlToText(html);
    expect(text).toContain('Title');
    expect(text).toContain('Paragraph bold');
  });

  it('decodes HTML entities', () => {
    const html = '&amp; &lt; &gt; &quot; &#39; &nbsp;';
    expect(htmlToText(html)).toBe('& < > " \'');
  });

  it('collapses excessive whitespace', () => {
    const html = '<div>Hello   \n\n   World</div>';
    const text = htmlToText(html);
    expect(text).toContain('Hello');
    expect(text).toContain('World');
  });

  it('handles empty string', () => {
    expect(htmlToText('')).toBe('');
  });

  it('handles plain text (no HTML)', () => {
    expect(htmlToText('Just plain text')).toBe('Just plain text');
  });

  it('extracts main content area when present', () => {
    const html = `
      <header><nav><a href="/">Home</a><a href="/about">About</a></nav></header>
      <main><h1>Article Title</h1><p>This is the real content of the page with important facts.</p></main>
      <footer><p>Copyright 2024</p></footer>
    `;
    const text = htmlToText(html);
    expect(text).toContain('Article Title');
    expect(text).toContain('real content');
    expect(text).not.toContain('Home');
    expect(text).not.toContain('Copyright');
  });

  it('extracts article content when no main tag', () => {
    const html = `
      <nav><a href="/">Menu Item 1</a></nav>
      <article><h1>Story</h1><p>The article body has more than two hundred characters of actual useful content that we want to extract for source checking purposes.</p></article>
      <aside><p>Sidebar content</p></aside>
    `;
    const text = htmlToText(html);
    expect(text).toContain('Story');
    expect(text).toContain('article body');
    expect(text).not.toContain('Menu Item');
    expect(text).not.toContain('Sidebar');
  });

  it('strips nav, header, footer, aside tags from full HTML', () => {
    const html = `
      <nav><a href="/">Nav Link</a></nav>
      <header><h1>Site Header</h1></header>
      <div><p>The actual page content</p></div>
      <footer><p>Footer text</p></footer>
      <aside><p>Side panel</p></aside>
    `;
    const text = htmlToText(html);
    expect(text).toContain('actual page content');
    expect(text).not.toContain('Nav Link');
    expect(text).not.toContain('Site Header');
    expect(text).not.toContain('Footer text');
    expect(text).not.toContain('Side panel');
  });

  it('falls back to full HTML when main/article too short', () => {
    const html = '<main><p>Hi</p></main><div><p>Full body content is here with details</p></div>';
    const text = htmlToText(html);
    // <main> has < 200 chars, so falls back to full HTML
    expect(text).toContain('Full body content');
  });
});
