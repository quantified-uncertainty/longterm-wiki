import { describe, it, expect } from 'vitest';
import { isPlaceholderUrl } from './verify-source.ts';

describe('isPlaceholderUrl', () => {
  it.each([
    'https://theverge.com/news/627849/auto-draft',
    'https://example.com/some/path/auto-draft/',
    'https://example.com/wp-admin/post.php',
    'https://example.com/wp-admin',
    'https://example.com/?p=12345',
    'https://example.com/index.php?p=42&utm=x',
    'https://example.com/2025-04-15',
    'https://example.com/blog/2025-04-15/',
  ])('rejects placeholder URL: %s', (url) => {
    expect(isPlaceholderUrl(url)).toBe(true);
  });

  it.each([
    'https://anthropic.com/news/announcing-claude',
    'https://example.com/articles/auto-draft-explained', // 'auto-draft' inside a longer slug
    'https://example.com/2025-annual-report',
    'https://example.com/?utm_source=x&utm_medium=y',
    // Deliberately accepted (the patterns are tight by design):
    'https://congress.gov/draft-bill-on-ai-safety',          // legal "draft" articles
    'https://example.com/draft-some-slug/',                  // generic draft-* slug
    'https://espn.com/preview/2025-nfl-draft',               // sports preview content
    'https://example.com/preview/q3-earnings',
  ])('accepts real URL: %s', (url) => {
    expect(isPlaceholderUrl(url)).toBe(false);
  });

  it('returns false for unparseable URLs', () => {
    expect(isPlaceholderUrl('not a url')).toBe(false);
    expect(isPlaceholderUrl('')).toBe(false);
  });
});
