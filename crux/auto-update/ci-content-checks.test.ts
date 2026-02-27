/**
 * Tests for CI content quality checks (truncation + footnote detection)
 *
 * Tests the pure functions that detect truncation and dangling footnotes.
 * These functions are called by the auto-update pipeline to catch content
 * quality issues before pages are committed.
 */

import { describe, it, expect } from 'vitest';
import {
  countWords,
  checkTruncation,
  extractFootnotes,
  findOrphanedRefs,
} from './ci-content-checks.ts';

// ── countWords ───────────────────────────────────────────────────────────────

describe('countWords', () => {
  it('counts words separated by spaces', () => {
    expect(countWords('hello world foo bar')).toBe(4);
  });

  it('handles multiple whitespace types', () => {
    expect(countWords('hello\tworld\nfoo  bar')).toBe(4);
  });

  it('returns 0 for empty string', () => {
    expect(countWords('')).toBe(0);
  });

  it('returns 0 for whitespace-only string', () => {
    expect(countWords('   \n\t  ')).toBe(0);
  });

  it('counts single word', () => {
    expect(countWords('hello')).toBe(1);
  });
});

// ── checkTruncation ──────────────────────────────────────────────────────────

describe('checkTruncation', () => {
  it('returns ok when content stays the same size', () => {
    const result = checkTruncation('hello world foo bar', 'hello world baz qux');
    expect(result.status).toBe('ok');
    expect(result.dropPercent).toBe(0);
  });

  it('returns ok when content grows', () => {
    const result = checkTruncation(
      'hello world foo bar baz qux extra words here',
      'hello world foo',
    );
    expect(result.status).toBe('ok');
  });

  it('returns ok for new pages (no base content)', () => {
    const result = checkTruncation('hello world foo bar', null);
    expect(result.status).toBe('ok');
    expect(result.beforeWords).toBe(0);
  });

  it('returns warning for 15-29% shrinkage', () => {
    // 100 words → 80 words = 20% shrinkage
    const base = Array(100).fill('word').join(' ');
    const current = Array(80).fill('word').join(' ');
    const result = checkTruncation(current, base);
    expect(result.status).toBe('warning');
    expect(result.dropPercent).toBe(20);
  });

  it('returns blocked for 30%+ shrinkage', () => {
    // 100 words → 60 words = 40% shrinkage
    const base = Array(100).fill('word').join(' ');
    const current = Array(60).fill('word').join(' ');
    const result = checkTruncation(current, base);
    expect(result.status).toBe('blocked');
    expect(result.dropPercent).toBe(40);
  });

  it('returns blocked at exactly 30%', () => {
    const base = Array(100).fill('word').join(' ');
    const current = Array(70).fill('word').join(' ');
    const result = checkTruncation(current, base);
    expect(result.status).toBe('blocked');
    expect(result.dropPercent).toBe(30);
  });

  it('returns ok for small shrinkage below 15%', () => {
    // 100 words → 90 words = 10% shrinkage
    const base = Array(100).fill('word').join(' ');
    const current = Array(90).fill('word').join(' ');
    const result = checkTruncation(current, base);
    expect(result.status).toBe('ok');
    expect(result.dropPercent).toBe(10);
  });
});

// ── extractFootnotes ─────────────────────────────────────────────────────────

describe('extractFootnotes', () => {
  it('extracts inline refs and definitions', () => {
    const content = [
      'Some text with a citation[^1] and another[^2].',
      '',
      '[^1]: First source',
      '[^2]: Second source',
    ].join('\n');

    const { refs, defs } = extractFootnotes(content);
    expect([...refs].sort()).toEqual(['1', '2']);
    expect([...defs].sort()).toEqual(['1', '2']);
  });

  it('skips footnotes inside code fences', () => {
    const content = [
      'Normal text[^1].',
      '```',
      'Code with [^2] ref',
      '```',
      'More text[^3].',
      '',
      '[^1]: Source 1',
      '[^3]: Source 3',
    ].join('\n');

    const { refs, defs } = extractFootnotes(content);
    expect([...refs].sort()).toEqual(['1', '3']);
    expect(refs.has('2')).toBe(false);
  });

  it('skips SRC-style markers', () => {
    const content = [
      'Text[^SRC-1] and [^S1-SRC-2] markers.',
      'Normal[^1] ref.',
      '',
      '[^1]: Source',
    ].join('\n');

    const { refs } = extractFootnotes(content);
    expect(refs.has('1')).toBe(true);
    expect(refs.has('SRC-1')).toBe(false);
    expect(refs.has('S1-SRC-2')).toBe(false);
  });

  it('handles empty content', () => {
    const { refs, defs } = extractFootnotes('');
    expect(refs.size).toBe(0);
    expect(defs.size).toBe(0);
  });

  it('handles named footnotes', () => {
    const content = [
      'Some text[^source-name].',
      '',
      '[^source-name]: https://example.com',
    ].join('\n');

    const { refs, defs } = extractFootnotes(content);
    expect(refs.has('source-name')).toBe(true);
    expect(defs.has('source-name')).toBe(true);
  });
});

// ── findOrphanedRefs ─────────────────────────────────────────────────────────

describe('findOrphanedRefs', () => {
  it('returns empty arrays when all refs have defs', () => {
    const content = [
      'Text[^1] and[^2].',
      '',
      '[^1]: Source 1',
      '[^2]: Source 2',
    ].join('\n');

    const { orphanedRefs, orphanedDefs } = findOrphanedRefs(content);
    expect(orphanedRefs).toEqual([]);
    expect(orphanedDefs).toEqual([]);
  });

  it('detects orphaned inline refs (refs without definitions)', () => {
    const content = [
      'Text[^1] and[^2] and[^3].',
      '',
      '[^1]: Source 1',
      // ^2 and ^3 have no definitions
    ].join('\n');

    const { orphanedRefs } = findOrphanedRefs(content);
    expect(orphanedRefs).toEqual(['2', '3']);
  });

  it('detects orphaned definitions (defs without refs)', () => {
    const content = [
      'Text[^1].',
      '',
      '[^1]: Source 1',
      '[^2]: Source 2 (orphaned)',
      '[^3]: Source 3 (orphaned)',
    ].join('\n');

    const { orphanedDefs } = findOrphanedRefs(content);
    expect(orphanedDefs).toEqual(['2', '3']);
  });

  it('handles truncated page with many dangling refs', () => {
    // Simulates a page truncated mid-content: refs 5-10 point to definitions
    // that were cut off
    const content = [
      'Introduction[^1] to the topic[^2].',
      'More content[^3] with citations[^4].',
      'Truncated here[^5][^6][^7][^8][^9][^10].',
      '',
      '[^1]: Source 1',
      '[^2]: Source 2',
      '[^3]: Source 3',
      '[^4]: Source 4',
      // Definitions 5-10 were truncated
    ].join('\n');

    const { orphanedRefs } = findOrphanedRefs(content);
    expect(orphanedRefs).toEqual(['10', '5', '6', '7', '8', '9']);
  });

  it('returns empty for content with no footnotes', () => {
    const content = 'Just plain text without any footnotes.';

    const { orphanedRefs, orphanedDefs } = findOrphanedRefs(content);
    expect(orphanedRefs).toEqual([]);
    expect(orphanedDefs).toEqual([]);
  });
});
