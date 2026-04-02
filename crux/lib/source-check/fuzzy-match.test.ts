import { describe, it, expect } from 'vitest';
import { normalizeOrgName, editDistance, nameMatches, amountMatches, dateMatches } from './fuzzy-match.ts';

describe('normalizeOrgName', () => {
  it('strips common suffixes', () => {
    expect(normalizeOrgName('Anthropic Inc.')).toBe('anthropic');
    expect(normalizeOrgName('OpenAI LLC')).toBe('openai');
    expect(normalizeOrgName('The Ford Foundation')).toBe('ford');
  });

  it('lowercases and collapses whitespace', () => {
    expect(normalizeOrgName('  MIRI   Research  ')).toBe('miri research');
  });

  it('strips diacritics', () => {
    expect(normalizeOrgName('Nuño Sempere')).toBe('nuno sempere');
  });

  it('strips parenthetical disambiguation', () => {
    expect(normalizeOrgName('CEA (Centre for Effective Altruism)')).toBe('cea');
  });
});

describe('editDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(editDistance('abc', 'abc')).toBe(0);
  });

  it('handles empty strings', () => {
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('abc', '')).toBe(3);
  });

  it('computes correct distance', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('saturday', 'sunday')).toBe(3);
  });
});

describe('nameMatches', () => {
  it('matches identical names', () => {
    expect(nameMatches('Anthropic', 'Anthropic')).toBe(true);
  });

  it('matches with different suffixes', () => {
    expect(nameMatches('Anthropic Inc.', 'Anthropic')).toBe(true);
    expect(nameMatches('The Ford Foundation', 'Ford Foundation')).toBe(true);
  });

  it('matches with minor typos', () => {
    expect(nameMatches('Open Philanthropy', 'Open Philantropy')).toBe(true);
  });

  it('rejects clearly different names', () => {
    expect(nameMatches('Anthropic', 'DeepMind')).toBe(false);
    expect(nameMatches('MIT', 'Stanford')).toBe(false);
  });

  it('handles Unicode normalization', () => {
    expect(nameMatches('Nuño Sempere', 'Nuno Sempere')).toBe(true);
  });
});

describe('amountMatches', () => {
  it('matches identical amounts', () => {
    expect(amountMatches(50000, 50000)).toBe(true);
  });

  it('matches null-null', () => {
    expect(amountMatches(null, null)).toBe(false);
  });

  it('rejects null vs value', () => {
    expect(amountMatches(50000, null)).toBe(false);
    expect(amountMatches(null, 50000)).toBe(false);
  });

  it('matches large amounts within tolerance', () => {
    expect(amountMatches(5000000, 5004999)).toBe(true);
  });

  it('rejects large amounts beyond tolerance', () => {
    expect(amountMatches(5000000, 5100000)).toBe(false);
  });

  it('requires exact match for small amounts', () => {
    expect(amountMatches(100, 101)).toBe(true); // within $1
    expect(amountMatches(100, 105)).toBe(false);
  });
});

describe('dateMatches', () => {
  it('matches identical dates', () => {
    expect(dateMatches('2018-07', '2018-07')).toBe(true);
  });

  it('matches year-only with year-month', () => {
    expect(dateMatches('2018', '2018-07')).toBe(true);
  });

  it('matches year-month with full date', () => {
    expect(dateMatches('2018-07', '2018-07-15')).toBe(true);
  });

  it('rejects different years', () => {
    expect(dateMatches('2018', '2019')).toBe(false);
  });

  it('rejects different months when both present', () => {
    expect(dateMatches('2018-07', '2018-08')).toBe(false);
  });

  it('handles nulls', () => {
    expect(dateMatches(null, null)).toBe(true);
    expect(dateMatches('2018', null)).toBe(false);
  });
});
