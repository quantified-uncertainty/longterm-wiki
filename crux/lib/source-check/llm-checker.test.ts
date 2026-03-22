/**
 * Tests for llm-checker.ts
 */
import { describe, it, expect } from 'vitest';
import { validateVerdict } from './llm-checker.ts';

describe('validateVerdict', () => {
  it('returns valid verdicts unchanged', () => {
    expect(validateVerdict('confirmed')).toBe('confirmed');
    expect(validateVerdict('contradicted')).toBe('contradicted');
    expect(validateVerdict('unverifiable')).toBe('unverifiable');
    expect(validateVerdict('outdated')).toBe('outdated');
    expect(validateVerdict('partial')).toBe('partial');
  });

  it('returns "unverifiable" for invalid verdicts', () => {
    expect(validateVerdict('unknown')).toBe('unverifiable');
    expect(validateVerdict('')).toBe('unverifiable');
    expect(validateVerdict('CONFIRMED')).toBe('unverifiable'); // case-sensitive
    expect(validateVerdict('true')).toBe('unverifiable');
    expect(validateVerdict('yes')).toBe('unverifiable');
  });

  it('returns "unverifiable" for empty/whitespace strings', () => {
    expect(validateVerdict('')).toBe('unverifiable');
    expect(validateVerdict(' ')).toBe('unverifiable');
  });
});
