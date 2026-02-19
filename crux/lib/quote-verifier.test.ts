import { describe, it, expect } from 'vitest';
import { verifyQuoteInSource } from './quote-verifier.ts';

describe('verifyQuoteInSource', () => {
  const sourceText = `
    The field of artificial intelligence has grown significantly in recent years.
    According to recent reports, global AI investment reached $93 billion in 2021.
    This represents a doubling from the previous year's investment levels.
    Many researchers believe that transformative AI could arrive within the next few decades.
  `.trim();

  it('returns exact match with score 1.0', () => {
    const quote = 'global AI investment reached $93 billion in 2021';
    const result = verifyQuoteInSource(quote, sourceText);
    expect(result.verified).toBe(true);
    expect(result.method).toBe('exact');
    expect(result.score).toBe(1.0);
    expect(result.matchOffset).toBeDefined();
  });

  it('returns normalized match for whitespace differences', () => {
    // Extra spaces
    const quote = 'global  AI  investment  reached  $93  billion  in  2021';
    const result = verifyQuoteInSource(quote, sourceText);
    expect(result.verified).toBe(true);
    expect(result.method).toBe('normalized');
    expect(result.score).toBe(0.95);
  });

  it('returns fuzzy match for similar content', () => {
    const quote =
      'AI investment reached approximately 93 billion dollars in the year 2021';
    const result = verifyQuoteInSource(quote, sourceText);
    // Should find a fuzzy match with reasonable score
    expect(result.score).toBeGreaterThan(0);
  });

  it('returns no match for completely unrelated text', () => {
    const quote =
      'The stock market crashed in 1929 causing widespread economic devastation';
    const result = verifyQuoteInSource(quote, sourceText);
    expect(result.verified).toBe(false);
    expect(result.method).toBe('none');
    expect(result.score).toBeLessThan(0.4);
  });

  it('handles empty inputs', () => {
    expect(verifyQuoteInSource('', sourceText).verified).toBe(false);
    expect(verifyQuoteInSource('hello', '').verified).toBe(false);
    expect(verifyQuoteInSource('', '').verified).toBe(false);
  });

  it('handles smart quotes and dashes', () => {
    const sourceWithSmartQuotes =
      'The report stated \u201Csignificant progress\u201D in the field \u2014 exceeding expectations.';
    const quote = "The report stated 'significant progress' in the field - exceeding expectations.";
    const result = verifyQuoteInSource(quote, sourceWithSmartQuotes);
    expect(result.verified).toBe(true);
    expect(result.method).toBe('normalized');
  });

  it('handles very short quotes gracefully', () => {
    const result = verifyQuoteInSource('AI', sourceText);
    // Too short for fuzzy matching
    expect(result.method === 'exact' || result.method === 'normalized' || result.method === 'none').toBe(true);
  });
});
