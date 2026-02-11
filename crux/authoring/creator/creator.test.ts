import { describe, it, expect } from 'vitest';
import { levenshteinDistance, similarity, toSlug } from './duplicate-detection.ts';
import { extractUrls } from './source-fetching.ts';

// ─── Duplicate Detection Tests ───

describe('Duplicate Detection', () => {
  it('levenshteinDistance: identical strings', () => {
    expect(levenshteinDistance('hello', 'hello')).toBe(0);
  });

  it('levenshteinDistance: one substitution', () => {
    expect(levenshteinDistance('hello', 'hallo')).toBe(1);
  });

  it('levenshteinDistance: one insertion', () => {
    expect(levenshteinDistance('hello', 'helloo')).toBe(1);
  });

  it('levenshteinDistance: one deletion', () => {
    expect(levenshteinDistance('hello', 'helo')).toBe(1);
  });

  it('levenshteinDistance: empty strings', () => {
    expect(levenshteinDistance('', '')).toBe(0);
    expect(levenshteinDistance('abc', '')).toBe(3);
    expect(levenshteinDistance('', 'abc')).toBe(3);
  });

  it('similarity: identical strings', () => {
    expect(similarity('hello', 'hello')).toBe(1);
  });

  it('similarity: case insensitive', () => {
    expect(similarity('Hello', 'hello')).toBe(1);
  });

  it('similarity: returns 0-1 range', () => {
    const sim = similarity('abc', 'xyz');
    expect(sim).toBeGreaterThanOrEqual(0);
    expect(sim).toBeLessThanOrEqual(1);
  });

  it('similarity: similar strings have high score', () => {
    const sim = similarity('OpenAI', 'OpenAi');
    expect(sim).toBeGreaterThanOrEqual(0.8);
  });

  it('similarity: very different strings have low score', () => {
    const sim = similarity('apple', 'bicycle');
    expect(sim).toBeLessThan(0.5);
  });

  it('toSlug: basic conversion', () => {
    expect(toSlug('Hello World')).toBe('hello-world');
  });

  it('toSlug: special characters', () => {
    expect(toSlug("Open Philanthropy's Fund")).toBe('open-philanthropy-s-fund');
  });

  it('toSlug: trims dashes', () => {
    expect(toSlug('--hello--')).toBe('hello');
  });

  it('toSlug: handles numbers', () => {
    expect(toSlug('80000 Hours')).toBe('80000-hours');
  });
});

// ─── URL Extraction Tests ───

describe('URL Extraction', () => {
  it('extractUrls: basic URL', () => {
    const urls = extractUrls('Check out https://example.com for more');
    expect(urls.length).toBe(1);
    expect(urls[0]).toBe('https://example.com');
  });

  it('extractUrls: multiple URLs', () => {
    const urls = extractUrls('See https://a.com and http://b.com');
    expect(urls.length).toBe(2);
  });

  it('extractUrls: strips trailing punctuation', () => {
    const urls = extractUrls('Visit https://example.com.');
    expect(urls[0]).toBe('https://example.com');
  });

  it('extractUrls: handles trailing comma', () => {
    const urls = extractUrls('Visit https://example.com, for more');
    expect(urls[0]).toBe('https://example.com');
  });

  it('extractUrls: handles unbalanced parens', () => {
    const urls = extractUrls('(see https://example.com/path)');
    expect(urls[0]).toBe('https://example.com/path');
  });

  it('extractUrls: preserves balanced parens in URL', () => {
    const urls = extractUrls('https://en.wikipedia.org/wiki/Test_(computing)');
    expect(urls[0]).toBe('https://en.wikipedia.org/wiki/Test_(computing)');
  });

  it('extractUrls: no URLs returns empty', () => {
    const urls = extractUrls('No links here');
    expect(urls.length).toBe(0);
  });
});
