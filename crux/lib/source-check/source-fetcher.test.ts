/**
 * Tests for source-fetcher.ts
 */
import { describe, it, expect } from 'vitest';
import {
  isPrivateHost,
  htmlToText,
  extractWikidataQid,
  WIKIDATA_PROPERTIES,
  COMMON_ENTITY_LABELS,
  RETRYABLE_STATUS_CODES,
  MAX_RETRIES,
  RETRY_DELAYS_MS,
} from './source-fetcher.ts';

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

describe('extractWikidataQid', () => {
  it('extracts QID from standard Wikidata URL', () => {
    expect(extractWikidataQid('https://www.wikidata.org/wiki/Q15733006')).toBe('Q15733006');
  });

  it('extracts QID from URL without www', () => {
    expect(extractWikidataQid('https://wikidata.org/wiki/Q42')).toBe('Q42');
  });

  it('extracts QID from HTTP URL', () => {
    expect(extractWikidataQid('http://www.wikidata.org/wiki/Q100')).toBe('Q100');
  });

  it('returns null for non-Wikidata URLs', () => {
    expect(extractWikidataQid('https://en.wikipedia.org/wiki/Google')).toBeNull();
    expect(extractWikidataQid('https://example.com')).toBeNull();
    expect(extractWikidataQid('https://www.wikidata.org/wiki/Property:P31')).toBeNull();
  });

  it('returns null for Wikidata URLs without QID', () => {
    expect(extractWikidataQid('https://www.wikidata.org/wiki/Main_Page')).toBeNull();
    expect(extractWikidataQid('https://www.wikidata.org/wiki/Special:Search')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractWikidataQid('')).toBeNull();
  });

  it('returns null for Wikidata URL with trailing path segments', () => {
    // Should only match exact entity pages, not subpages
    expect(extractWikidataQid('https://www.wikidata.org/wiki/Q42/something')).toBeNull();
  });

  it('returns null for Wikidata URL with query params', () => {
    // The regex requires exact match — query params would be after the QID
    expect(extractWikidataQid('https://www.wikidata.org/wiki/Q42?action=edit')).toBeNull();
  });
});

describe('WIKIDATA_PROPERTIES', () => {
  it('contains common organization properties', () => {
    expect(WIKIDATA_PROPERTIES).toHaveProperty('P571'); // Founded
    expect(WIKIDATA_PROPERTIES).toHaveProperty('P159'); // Headquarters
    expect(WIKIDATA_PROPERTIES).toHaveProperty('P856'); // Website
    expect(WIKIDATA_PROPERTIES).toHaveProperty('P1128'); // Employee count
    expect(WIKIDATA_PROPERTIES).toHaveProperty('P749'); // Parent organization
  });

  it('contains common person properties', () => {
    expect(WIKIDATA_PROPERTIES).toHaveProperty('P569'); // Date of birth
    expect(WIKIDATA_PROPERTIES).toHaveProperty('P570'); // Date of death
    expect(WIKIDATA_PROPERTIES).toHaveProperty('P27'); // Country of citizenship
    expect(WIKIDATA_PROPERTIES).toHaveProperty('P108'); // Employer
  });

  it('has human-readable labels for all properties', () => {
    for (const [pid, label] of Object.entries(WIKIDATA_PROPERTIES)) {
      expect(label).toBeTruthy();
      expect(typeof label).toBe('string');
      expect(pid).toMatch(/^P\d+$/);
    }
  });
});

describe('COMMON_ENTITY_LABELS', () => {
  it('contains major countries', () => {
    expect(COMMON_ENTITY_LABELS.Q30).toBe('United States');
    expect(COMMON_ENTITY_LABELS.Q145).toBe('United Kingdom');
    expect(COMMON_ENTITY_LABELS.Q148).toBe('China');
  });

  it('contains major cities', () => {
    expect(COMMON_ENTITY_LABELS.Q84).toBe('London');
    expect(COMMON_ENTITY_LABELS.Q62).toBe('San Francisco');
    expect(COMMON_ENTITY_LABELS.Q18426).toBe('Mountain View');
  });

  it('contains common tech organizations', () => {
    expect(COMMON_ENTITY_LABELS.Q95).toBe('Google');
    expect(COMMON_ENTITY_LABELS.Q2283).toBe('Microsoft');
    expect(COMMON_ENTITY_LABELS.Q21692564).toBe('Alphabet Inc.');
  });

  it('has string values for all QID keys', () => {
    for (const [qid, label] of Object.entries(COMMON_ENTITY_LABELS)) {
      expect(label).toBeTruthy();
      expect(typeof label).toBe('string');
      expect(qid).toMatch(/^Q\d+$/);
    }
  });
});

describe('retry configuration', () => {
  it('retries transient server errors (429, 500, 502, 503)', () => {
    expect(RETRYABLE_STATUS_CODES.has(429)).toBe(true);
    expect(RETRYABLE_STATUS_CODES.has(500)).toBe(true);
    expect(RETRYABLE_STATUS_CODES.has(502)).toBe(true);
    expect(RETRYABLE_STATUS_CODES.has(503)).toBe(true);
  });

  it('does not retry permanent client errors (401, 403, 404)', () => {
    expect(RETRYABLE_STATUS_CODES.has(401)).toBe(false);
    expect(RETRYABLE_STATUS_CODES.has(403)).toBe(false);
    expect(RETRYABLE_STATUS_CODES.has(404)).toBe(false);
  });

  it('does not retry other status codes', () => {
    expect(RETRYABLE_STATUS_CODES.has(200)).toBe(false);
    expect(RETRYABLE_STATUS_CODES.has(301)).toBe(false);
    expect(RETRYABLE_STATUS_CODES.has(400)).toBe(false);
    expect(RETRYABLE_STATUS_CODES.has(418)).toBe(false);
  });

  it('has 2 retries with increasing backoff delays', () => {
    expect(MAX_RETRIES).toBe(2);
    expect(RETRY_DELAYS_MS).toHaveLength(2);
    expect(RETRY_DELAYS_MS[0]).toBe(1000);
    expect(RETRY_DELAYS_MS[1]).toBe(3000);
    // Second delay must be longer than first (backoff)
    expect(RETRY_DELAYS_MS[1]).toBeGreaterThan(RETRY_DELAYS_MS[0]);
  });

  it('has a delay entry for each retry attempt', () => {
    expect(RETRY_DELAYS_MS).toHaveLength(MAX_RETRIES);
  });
});
