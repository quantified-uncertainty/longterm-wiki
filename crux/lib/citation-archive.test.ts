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

  it('extracts only the specific list item, not sibling items', () => {
    const body = `## Timeline

- **2016**: Open Philanthropy estimated 10% probability of transformative AI within 20 years[^1]
- **2020**: Metaculus community median moved from 2040 to 2030[^2]
- **2023**: Average forecast shifted to 25% by 2030[^3]

[^1]: [OP Report](https://example.com/op)
[^2]: [Metaculus](https://example.com/meta)
[^3]: [Survey](https://example.com/survey)`;

    const claim1 = extractClaimSentence(body, 1);
    // Should only contain the 2016 item
    expect(claim1).toContain('Open Philanthropy estimated 10%');
    // Should NOT contain sibling list items
    expect(claim1).not.toContain('Metaculus');
    expect(claim1).not.toContain('2023');

    const claim2 = extractClaimSentence(body, 2);
    expect(claim2).toContain('Metaculus community median');
    expect(claim2).not.toContain('Open Philanthropy');
    expect(claim2).not.toContain('2023');
  });

  it('handles list items with continuation lines', () => {
    const body = `## Mentors

- **Alice**: Researcher at Lab A, focuses on
  alignment and interpretability[^1]
- **Bob**: Researcher at Lab B[^2]

[^1]: [Source](https://example.com/1)
[^2]: [Source](https://example.com/2)`;

    const claim1 = extractClaimSentence(body, 1);
    expect(claim1).toContain('Alice');
    expect(claim1).toContain('alignment and interpretability');
    expect(claim1).not.toContain('Bob');
  });

  it('handles numbered list items', () => {
    const body = `## Steps

1. First step with a claim[^1]
2. Second step with another[^2]

[^1]: [Source](https://example.com/1)
[^2]: [Source](https://example.com/2)`;

    const claim1 = extractClaimSentence(body, 1);
    expect(claim1).toContain('First step');
    expect(claim1).not.toContain('Second step');
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

  it('extracts academic-style embedded link citations', () => {
    const body = `
AI timelines are uncertain.[^1]

[^1]: Holden Karnofsky, "[Some Background on Our Views Regarding Advanced AI](https://example.com/karnofsky)," Open Philanthropy, 2016.
`;
    const citations = extractCitationsFromContent(body);
    expect(citations.length).toBe(1);
    expect(citations[0].footnote).toBe(1);
    expect(citations[0].url).toBe('https://example.com/karnofsky');
    expect(citations[0].linkText).toContain('Some Background on Our Views');
    expect(citations[0].linkText).toContain('Holden Karnofsky');
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

  it('extracts text-then-bare-URL citations', () => {
    const body = `
TransformerLens is a key tool.[^1] It was built for mechanistic interpretability.[^2]

[^1]: TransformerLens GitHub repository: https://github.com/neelnanda-io/TransformerLens
[^2]: Elhage, N., Nanda, N., et al. (2021). "A Mathematical Framework for Transformer Circuits." Transformer Circuits Thread. https://transformer-circuits.pub/2021/framework/index.html
`;
    const citations = extractCitationsFromContent(body);
    expect(citations.length).toBe(2);

    expect(citations[0].footnote).toBe(1);
    expect(citations[0].url).toBe('https://github.com/neelnanda-io/TransformerLens');
    expect(citations[0].linkText).toBe('TransformerLens GitHub repository');

    expect(citations[1].footnote).toBe(2);
    expect(citations[1].url).toBe('https://transformer-circuits.pub/2021/framework/index.html');
    expect(citations[1].linkText).toContain('Mathematical Framework');
  });

  it('skips footnotes without URLs', () => {
    const body = `
Some claim.[^1] Another claim.[^2]

[^1]: [Report](https://example.com/report)
[^2]: Based on statements in blog posts discussing limitations
`;
    const citations = extractCitationsFromContent(body);
    expect(citations.length).toBe(1);
    expect(citations[0].footnote).toBe(1);
  });

  it('handles mixed footnote formats in the same page', () => {
    const body = `
Claim A.[^1] Claim B.[^2] Claim C.[^3] Claim D.[^4]

[^1]: [Titled Link](https://example.com/titled)
[^2]: Author, "[Embedded Link](https://example.com/embedded)," Journal, 2024.
[^3]: Description text: https://example.com/text-url
[^4]: https://example.com/bare
`;
    const citations = extractCitationsFromContent(body);
    expect(citations.length).toBe(4);
    expect(citations[0].url).toBe('https://example.com/titled');
    expect(citations[1].url).toBe('https://example.com/embedded');
    expect(citations[2].url).toBe('https://example.com/text-url');
    expect(citations[3].url).toBe('https://example.com/bare');
  });
});
