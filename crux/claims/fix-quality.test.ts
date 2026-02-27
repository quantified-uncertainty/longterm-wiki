import { describe, it, expect } from 'vitest';
import { isClaimDuplicate, deduplicateClaims } from '../lib/claim-utils.ts';
import { stripMarkupFromText, hasMarkup } from './fix-quality.ts';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stripMarkupFromText', () => {
  it('strips EntityLink tags preserving inner text', () => {
    const input = 'Anthropic invested in <EntityLink id="openai">OpenAI</EntityLink> research.';
    const { cleaned, strippedLabels } = stripMarkupFromText(input);
    expect(cleaned).toBe('Anthropic invested in OpenAI research.');
    expect(strippedLabels).toContain('EntityLink');
  });

  it('strips <F> canonical fact tags', () => {
    const input = 'Revenue was <F id="abc123" /> in 2024.';
    const { cleaned, strippedLabels } = stripMarkupFromText(input);
    expect(cleaned).toBe('Revenue was in 2024.');
    expect(strippedLabels).toContain('F-tag');
  });

  it('strips <R> citation components', () => {
    const input = 'According to <R id="hash123">this source</R>, AI is growing.';
    const { cleaned } = stripMarkupFromText(input);
    expect(cleaned).toBe('According to , AI is growing.');
  });

  it('unescapes dollar signs', () => {
    const input = 'Anthropic raised \\$100M in 2023.';
    const { cleaned, strippedLabels } = stripMarkupFromText(input);
    expect(cleaned).toBe('Anthropic raised $100M in 2023.');
    expect(strippedLabels).toContain('escaped-dollar');
  });

  it('unescapes angle brackets', () => {
    const input = 'Latency was \\<100ms on average.';
    const { cleaned } = stripMarkupFromText(input);
    expect(cleaned).toBe('Latency was <100ms on average.');
  });

  it('removes curly brace expressions', () => {
    const input = 'The model {highlighted} achieved 95% accuracy.';
    const { cleaned } = stripMarkupFromText(input);
    expect(cleaned).toBe('The model achieved 95% accuracy.');
  });

  it('returns empty strippedLabels for clean text', () => {
    const input = 'Anthropic was founded in 2021 by Dario Amodei.';
    const { cleaned, strippedLabels } = stripMarkupFromText(input);
    expect(cleaned).toBe(input);
    expect(strippedLabels).toHaveLength(0);
  });

  it('handles multiple markup types in one claim', () => {
    const input = '<EntityLink id="anthropic">Anthropic</EntityLink> raised \\$2.75B from <EntityLink id="google">Google</EntityLink>.';
    const { cleaned, strippedLabels } = stripMarkupFromText(input);
    expect(cleaned).toBe('Anthropic raised $2.75B from Google.');
    expect(strippedLabels).toContain('EntityLink');
    expect(strippedLabels).toContain('escaped-dollar');
  });

  it('collapses multiple spaces after stripping', () => {
    const input = 'Anthropic  <F id="abc" />  has funding.';
    const { cleaned } = stripMarkupFromText(input);
    expect(cleaned).toBe('Anthropic has funding.');
  });
});

describe('hasMarkup', () => {
  it('detects EntityLink tags', () => {
    expect(hasMarkup('<EntityLink id="x">Text</EntityLink>')).toBe(true);
  });

  it('detects escaped dollar signs', () => {
    expect(hasMarkup('Raised \\$100M')).toBe(true);
  });

  it('returns false for clean text', () => {
    expect(hasMarkup('Anthropic was founded in 2021.')).toBe(false);
  });
});

describe('dedup logic (via claim-utils)', () => {
  it('detects exact duplicates after normalization', () => {
    expect(isClaimDuplicate(
      'Anthropic was founded in 2021.',
      'anthropic was founded in 2021',
    )).toBe(true);
  });

  it('detects paraphrase duplicates via Jaccard', () => {
    // These share >=75% word Jaccard similarity
    expect(isClaimDuplicate(
      'Anthropic raised $2.75 billion in its Series E round in 2024.',
      'Anthropic raised $2.75 billion in a Series E funding round in 2024.',
    )).toBe(true);
  });

  it('does not flag genuinely different claims', () => {
    expect(isClaimDuplicate(
      'Anthropic was founded in 2021.',
      'OpenAI was founded in 2015.',
    )).toBe(false);
  });

  it('deduplicates a batch correctly', () => {
    const newClaims = [
      { claimText: 'Anthropic was founded in 2021.' },
      { claimText: 'anthropic was founded in 2021' }, // dup of first
      { claimText: 'OpenAI has GPT-4.' },
    ];
    const existing = ['Anthropic was founded in 2021.'];
    const { unique, duplicateCount } = deduplicateClaims(newClaims, existing);
    expect(duplicateCount).toBe(2); // first two are dups of existing
    expect(unique).toHaveLength(1);
    expect(unique[0].claimText).toBe('OpenAI has GPT-4.');
  });
});
