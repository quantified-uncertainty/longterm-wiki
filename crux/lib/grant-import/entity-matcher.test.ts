import { describe, it, expect } from 'vitest';
import { normalizeGranteeName } from './entity-matcher.ts';

describe('normalizeGranteeName', () => {
  it('strips a plain suffix from STRIP_SUFFIXES', () => {
    expect(normalizeGranteeName('OpenAI LLC')).toBe('OpenAI');
  });

  it('strips a comma-separated suffix', () => {
    expect(normalizeGranteeName('OpenAI, Inc.')).toBe('OpenAI');
  });

  it('strips a suffix that contains regex metacharacters (dots) safely', () => {
    // "l.l.c." is in STRIP_SUFFIXES and contains dots, which are regex metachars.
    expect(normalizeGranteeName('Acme L.L.C.')).toBe('Acme');
  });

  it('does not throw and treats regex-special chars in input literally', () => {
    // Parentheses are regex metacharacters; they must not break the matcher.
    expect(() => normalizeGranteeName('Acme (Holdings) Inc')).not.toThrow();
    expect(normalizeGranteeName('Acme (Holdings) Inc')).toBe('Acme (Holdings)');
  });

  it('collapses extra whitespace', () => {
    expect(normalizeGranteeName('  Big   Org   ')).toBe('Big Org');
  });

  it('leaves a name without a known suffix unchanged', () => {
    expect(normalizeGranteeName('OpenAI')).toBe('OpenAI');
  });
});
