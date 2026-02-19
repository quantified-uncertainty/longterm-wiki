import { describe, it, expect } from 'vitest';
import { classifyFootnote, extractBestTitle } from './normalize-footnotes.ts';

describe('classifyFootnote', () => {
  it('classifies markdown-link format', () => {
    const result = classifyFootnote('[^1]: [Report Title](https://example.com/report)');
    expect(result).not.toBeNull();
    expect(result!.format).toBe('markdown-link');
    expect(result!.normalizedLine).toBeNull();
  });

  it('classifies embedded markdown-link format', () => {
    const result = classifyFootnote('[^1]: Author, "[Title](https://example.com/paper)," Journal, 2024.');
    expect(result).not.toBeNull();
    expect(result!.format).toBe('markdown-link');
  });

  it('classifies text-then-url format', () => {
    const result = classifyFootnote('[^1]: TransformerLens GitHub repository: https://github.com/foo/bar');
    expect(result).not.toBeNull();
    expect(result!.format).toBe('text-then-url');
    expect(result!.url).toBe('https://github.com/foo/bar');
    expect(result!.normalizedLine).toBe('[^1]: [TransformerLens GitHub repository](https://github.com/foo/bar)');
  });

  it('classifies bare-url format', () => {
    const result = classifyFootnote('[^1]: https://example.com/bare');
    expect(result).not.toBeNull();
    expect(result!.format).toBe('bare-url');
    expect(result!.url).toBe('https://example.com/bare');
    expect(result!.normalizedLine).toBeNull();
  });

  it('classifies no-url format', () => {
    const result = classifyFootnote('[^1]: Based on statements in blog posts');
    expect(result).not.toBeNull();
    expect(result!.format).toBe('no-url');
    expect(result!.url).toBeNull();
  });

  it('returns null for non-footnote lines', () => {
    expect(classifyFootnote('Just a normal line')).toBeNull();
    expect(classifyFootnote('# Heading')).toBeNull();
  });

  it('handles academic citation with quoted title', () => {
    const result = classifyFootnote(
      '[^3]: Elhage, N. (2021). "A Mathematical Framework." Thread. https://example.com/paper',
    );
    expect(result).not.toBeNull();
    expect(result!.format).toBe('text-then-url');
    expect(result!.linkText).toContain('A Mathematical Framework');
  });
});

describe('extractBestTitle', () => {
  it('extracts quoted title with context', () => {
    const title = extractBestTitle('Author (2024). "My Paper Title." Journal');
    expect(title).toContain('My Paper Title');
    expect(title).toContain('Author');
  });

  it('handles text without quotes', () => {
    const title = extractBestTitle('TransformerLens GitHub repository:');
    expect(title).toBe('TransformerLens GitHub repository');
  });

  it('cleans trailing punctuation', () => {
    const title = extractBestTitle('Some title, with trailing commas,,');
    expect(title).toBe('Some title, with trailing commas');
  });
});
