import { describe, it, expect } from 'vitest';
import {
  normalizeClaimText,
  isClaimDuplicate,
  deduplicateClaims,
} from './claim-utils.ts';

describe('normalizeClaimText', () => {
  it('lowercases text', () => {
    expect(normalizeClaimText('OpenAI Was Founded in 2015')).toBe(
      'openai was founded in 2015',
    );
  });

  it('collapses whitespace', () => {
    expect(normalizeClaimText('OpenAI   was  founded\nin  2015')).toBe(
      'openai was founded in 2015',
    );
  });

  it('strips trailing punctuation', () => {
    expect(normalizeClaimText('OpenAI was founded in 2015.')).toBe(
      'openai was founded in 2015',
    );
    expect(normalizeClaimText('Revenue reached $1B!!')).toBe(
      'revenue reached $1b',
    );
  });

  it('handles empty string', () => {
    expect(normalizeClaimText('')).toBe('');
  });
});

describe('isClaimDuplicate', () => {
  it('detects exact matches after normalization', () => {
    expect(
      isClaimDuplicate(
        'OpenAI was founded in 2015.',
        'openai was founded in 2015',
      ),
    ).toBe(true);
  });

  it('detects substring containment with high overlap', () => {
    expect(
      isClaimDuplicate(
        'OpenAI was founded in 2015',
        'OpenAI was founded in 2015 by Sam Altman',
      ),
    ).toBe(true);
  });

  it('rejects substring containment with low overlap', () => {
    expect(
      isClaimDuplicate(
        'OpenAI',
        'OpenAI was founded in 2015 by Sam Altman and others in San Francisco',
      ),
    ).toBe(false);
  });

  it('detects Jaccard similarity above threshold', () => {
    expect(
      isClaimDuplicate(
        'OpenAI was founded in 2015 by Sam Altman',
        'Sam Altman founded OpenAI in 2015',
      ),
    ).toBe(true);
  });

  it('rejects dissimilar claims', () => {
    expect(
      isClaimDuplicate(
        'OpenAI was founded in 2015',
        'Anthropic focuses on AI safety research',
      ),
    ).toBe(false);
  });

  it('respects custom threshold', () => {
    // With a high threshold these should NOT match
    expect(
      isClaimDuplicate(
        'OpenAI was founded in 2015 by Sam Altman',
        'Sam Altman co-founded OpenAI in December 2015',
        0.95,
      ),
    ).toBe(false);
  });
});

describe('deduplicateClaims', () => {
  it('filters out duplicate claims', () => {
    const newClaims = [
      { claimText: 'OpenAI was founded in 2015.', claimType: 'factual' as const },
      { claimText: 'Anthropic focuses on AI safety.', claimType: 'factual' as const },
      { claimText: 'openai was founded in 2015', claimType: 'factual' as const },
    ];
    const existing = ['OpenAI was founded in 2015'];

    const result = deduplicateClaims(newClaims, existing);
    expect(result.unique).toHaveLength(1);
    expect(result.unique[0].claimText).toBe('Anthropic focuses on AI safety.');
    expect(result.duplicateCount).toBe(2);
  });

  it('returns all claims when no duplicates', () => {
    const newClaims = [
      { claimText: 'Claim A', claimType: 'factual' as const },
      { claimText: 'Claim B', claimType: 'factual' as const },
    ];
    const result = deduplicateClaims(newClaims, ['Totally different']);
    expect(result.unique).toHaveLength(2);
    expect(result.duplicateCount).toBe(0);
  });

  it('handles empty inputs', () => {
    const result = deduplicateClaims([], ['existing claim']);
    expect(result.unique).toHaveLength(0);
    expect(result.duplicateCount).toBe(0);
  });
});
