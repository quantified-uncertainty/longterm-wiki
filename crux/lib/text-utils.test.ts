import { describe, it, expect } from 'vitest';
import { truncate } from './text-utils';

describe('truncate', () => {
  describe('default behavior — single-char ellipsis, budget-inclusive', () => {
    it('returns short strings unchanged', () => {
      expect(truncate('hi', 10)).toBe('hi');
      expect(truncate('exactly 10', 10)).toBe('exactly 10');
    });

    it('truncates with ellipsis counting toward max', () => {
      expect(truncate('a long string', 5)).toBe('a lo…');
      expect(truncate('a long string', 5)).toHaveLength(5);
    });

    it('handles null/undefined with empty fallback', () => {
      expect(truncate(null, 10)).toBe('');
      expect(truncate(undefined, 10)).toBe('');
    });

    it('honors custom fallback', () => {
      expect(truncate(null, 10, { fallback: '—' })).toBe('—');
    });

    it('treats empty string as a non-null value (NOT fallback)', () => {
      // Wrappers that want '' to map to fallback must guard with !s themselves.
      // sessions-list's truncate() does this; see its test for the regression.
      expect(truncate('', 10, { fallback: '—' })).toBe('');
    });

    it('preserves \\r in oneLine mode (only \\n is collapsed)', () => {
      expect(truncate('a\r\nb', 10, { oneLine: true })).toBe('a\r b');
    });
  });

  describe('ellipsis option', () => {
    it('supports 3-dot ASCII ellipsis', () => {
      expect(truncate('a long string', 8, { ellipsis: '...' })).toBe('a lon...');
      expect(truncate('a long string', 8, { ellipsis: '...' })).toHaveLength(8);
    });

    it('supports custom multi-char marker', () => {
      expect(truncate('hello world', 9, { ellipsis: '… (cut)' })).toBe('he… (cut)');
    });

    it('handles ellipsis longer than max gracefully', () => {
      expect(truncate('hello', 2, { ellipsis: '...' })).toBe('..');
      expect(truncate('hello', 0, { ellipsis: '...' })).toBe('');
    });
  });

  describe('showCount', () => {
    it('appends a count annotation when truncating', () => {
      expect(truncate('abcdefghij', 5, { showCount: true })).toBe(
        'abcde… [truncated, 5 more chars]',
      );
    });

    it('does nothing when input is short enough', () => {
      expect(truncate('hi', 5, { showCount: true })).toBe('hi');
    });

    it('overrides ellipsis when both are set', () => {
      expect(truncate('abcdefghij', 5, { showCount: true, ellipsis: '...' })).toBe(
        'abcde… [truncated, 5 more chars]',
      );
    });

    it('ignores wordBoundary when showCount is true (showCount cuts at exact max)', () => {
      // showCount documents content length, so backing up to a word boundary
      // would break the "5 more chars" math. The cut must land at exactly max.
      expect(
        truncate('hello world foo', 5, { showCount: true, wordBoundary: true }),
      ).toBe('hello… [truncated, 10 more chars]');
    });

    it('still collapses newlines when oneLine is set with showCount', () => {
      expect(
        truncate('a\nb\nc\nd\ne\nf', 3, { showCount: true, oneLine: true }),
      ).toBe('a b… [truncated, 8 more chars]');
    });
  });

  describe('wordBoundary', () => {
    it('backs up to the last whitespace before the cut', () => {
      expect(truncate('hello world foo', 10, { wordBoundary: true })).toBe('hello…');
    });

    it('keeps the cut at the budget if no space exists past half', () => {
      // budget = 9, half = 4.5. Last space in 'verylongw' is at -1. Use full budget.
      expect(truncate('verylongword extra', 10, { wordBoundary: true })).toBe('verylongw…');
    });

    it('falls back to budget cut when the only space is in the first half', () => {
      // budget=9, sub='a longest', lastSpace=1, 1 < 4.5, so cut at budget.
      expect(truncate('a longest possible run', 10, { wordBoundary: true })).toBe('a longest…');
    });
  });

  describe('oneLine', () => {
    it('collapses newlines to spaces before measuring', () => {
      // After collapse: 'line1 line2 line3' (17 chars) → truncated to 11 chars.
      expect(truncate('line1\nline2\nline3', 11, { oneLine: true })).toBe('line1 line…');
    });

    it('returns the collapsed form unchanged when shorter than max', () => {
      expect(truncate('line1\nline2', 20, { oneLine: true })).toBe('line1 line2');
    });

    it('does not modify content shorter than max', () => {
      expect(truncate('a\nb', 10, { oneLine: true })).toBe('a b');
    });
  });

  describe('combined options', () => {
    it('supports oneLine + custom ellipsis', () => {
      expect(truncate('a\nb\nc\nd\ne', 6, { oneLine: true, ellipsis: '...' })).toBe('a b...');
    });

    it('supports wordBoundary + custom ellipsis', () => {
      expect(
        truncate('hello world foo bar', 12, { wordBoundary: true, ellipsis: '...' }),
      ).toBe('hello...');
      // budget = 12 - 3 = 9, sub = 'hello wor', lastSpace=5, 5 > 4.5, cut=5 → 'hello'.
    });
  });
});
