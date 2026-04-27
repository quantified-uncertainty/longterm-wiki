import { describe, it, expect } from 'vitest';
import { splitProviders } from './report.ts';

describe('splitProviders', () => {
  it('splits a multi-provider tag into a sorted array', () => {
    expect(splitProviders('exa+perplexity')).toEqual(['exa', 'perplexity']);
    expect(splitProviders('perplexity+exa+scry')).toEqual(['exa', 'perplexity', 'scry']);
  });

  it('wraps a single provider as a 1-element array', () => {
    expect(splitProviders('exa')).toEqual(['exa']);
    expect(splitProviders('self-sourced')).toEqual(['self-sourced']);
  });

  it('returns [] for null / undefined / empty', () => {
    expect(splitProviders(null)).toEqual([]);
    expect(splitProviders(undefined)).toEqual([]);
    expect(splitProviders('')).toEqual([]);
  });

  it('trims and dedupes entries', () => {
    expect(splitProviders(' exa + exa ')).toEqual(['exa']);
    expect(splitProviders('exa++perplexity')).toEqual(['exa', 'perplexity']);
  });
});
