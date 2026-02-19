import { describe, it, expect } from 'vitest';
import { extractClaimSentence, extractCitationsFromContent } from './citation-archive.ts';

describe('extractClaimSentence', () => {
  const sampleBody = `
# AI Safety Overview

The field of AI safety research has grown rapidly. Global spending on AI safety reached an estimated \\$100 million by 2023.[^1] This represents significant growth from just a few years prior.

Several organizations lead this work. The Center for AI Safety published a statement warning that AI extinction risk should be a global priority.[^2]

Many experts believe that transformative AI could arrive within decades.[^3] However, timelines remain highly uncertain.

[^1]: [AI Safety Funding Report](https://example.com/report)
[^2]: [CAIS Statement](https://example.com/cais)
[^3]: Bostrom (2014). Superintelligence: Paths, Dangers, Strategies.
`.trim();

  it('extracts the sentence containing the footnote reference', () => {
    const claim = extractClaimSentence(sampleBody, 1);
    expect(claim).toContain('Global spending on AI safety');
    expect(claim).toContain('100 million');
    // Should not contain the footnote marker itself
    expect(claim).not.toContain('[^1]');
  });

  it('extracts claim for footnote 2', () => {
    const claim = extractClaimSentence(sampleBody, 2);
    expect(claim).toContain('Center for AI Safety');
    expect(claim).toContain('extinction risk');
  });

  it('extracts claim for footnote 3', () => {
    const claim = extractClaimSentence(sampleBody, 3);
    expect(claim).toContain('transformative AI');
  });

  it('returns empty string for non-existent footnote', () => {
    const claim = extractClaimSentence(sampleBody, 99);
    expect(claim).toBe('');
  });

  it('handles multiple footnotes on the same line', () => {
    const body = `Some fact[^1] and another fact[^2] in the same sentence.

[^1]: [Source 1](https://example.com/1)
[^2]: [Source 2](https://example.com/2)`;

    const claim1 = extractClaimSentence(body, 1);
    expect(claim1).toContain('Some fact');

    const claim2 = extractClaimSentence(body, 2);
    expect(claim2).toContain('another fact');
  });
});

describe('extractCitationsFromContent', () => {
  it('extracts titled link citations', () => {
    const body = `
Some claim here.[^1]

[^1]: [Report Title](https://example.com/report)
`;
    const citations = extractCitationsFromContent(body);
    expect(citations.length).toBe(1);
    expect(citations[0].footnote).toBe(1);
    expect(citations[0].url).toBe('https://example.com/report');
    expect(citations[0].linkText).toBe('Report Title');
  });

  it('extracts bare URL citations', () => {
    const body = `
Some claim here.[^1]

[^1]: https://example.com/bare
`;
    const citations = extractCitationsFromContent(body);
    expect(citations.length).toBe(1);
    expect(citations[0].url).toBe('https://example.com/bare');
    expect(citations[0].linkText).toBe('');
  });

  it('captures claim context from surrounding text', () => {
    const body = `
AI safety is important. The field has grown to \\$100M in funding.[^1] Growth continues.

[^1]: [Funding Report](https://example.com/funding)
`;
    const citations = extractCitationsFromContent(body);
    expect(citations[0].claimContext).toContain('100M');
  });
});
