import { describe, it, expect } from 'vitest';

import {
  extractMetrics,
  countWords,
  countTables,
  countDiagrams,
  countInternalLinks,
  countExternalLinks,
  countFootnoteRefs,
  suggestQuality,
} from './metrics-extractor.ts';

describe('countWords', () => {
  it('basic word count', () => {
    const count = countWords('Hello world this is a test');
    expect(count).toBe(6);
  });

  it('excludes code blocks', () => {
    const count = countWords('Word one\n```\ncode here not counted\n```\nWord two');
    // Should count 'Word one' and 'Word two' = 4 words, not the code
    expect(count).toBeLessThan(10);
  });

  it('empty content', () => {
    expect(countWords('')).toBe(0);
  });

  it('handles JSX components', () => {
    const count = countWords('Before <Mermaid chart={`graph TD`} /> After');
    // Should count Before and After but not the component
    expect(count).toBeLessThanOrEqual(4);
  });
});

describe('countTables', () => {
  it('single table', () => {
    const content = `| Header | Header |
| --- | --- |
| Cell | Cell |`;
    expect(countTables(content)).toBe(1);
  });

  it('no tables', () => {
    expect(countTables('Just some text')).toBe(0);
  });

  it('two tables', () => {
    const content = `| H1 | H2 |
| --- | --- |
| A | B |

Some text

| H3 | H4 |
| --- | --- |
| C | D |`;
    expect(countTables(content)).toBe(2);
  });
});

describe('countDiagrams', () => {
  it('Mermaid component', () => {
    const content = '<Mermaid chart={`graph TD`} />';
    expect(countDiagrams(content)).toBe(1);
  });

  it('mermaid code block', () => {
    const content = '```mermaid\ngraph TD\n```';
    expect(countDiagrams(content)).toBe(1);
  });

  it('no diagrams', () => {
    expect(countDiagrams('Just text')).toBe(0);
  });

  it('multiple diagrams', () => {
    const content = '<Mermaid chart={`graph TD`} />\n\n```mermaid\ngraph LR\n```';
    expect(countDiagrams(content)).toBe(2);
  });
});

describe('countInternalLinks', () => {
  it('markdown link', () => {
    expect(countInternalLinks('[text](/some-page)')).toBe(1);
  });

  it('EntityLink', () => {
    expect(countInternalLinks('<EntityLink id="test">Text</EntityLink>')).toBe(1);
  });

  it('R component', () => {
    expect(countInternalLinks('<R id="ref-1" />')).toBe(1);
  });

  it('mixed', () => {
    const content = '[link](/page) and <EntityLink id="x">X</EntityLink> and <R id="y" />';
    expect(countInternalLinks(content)).toBe(3);
  });
});

describe('countExternalLinks', () => {
  it('https link', () => {
    expect(countExternalLinks('[text](https://example.com)')).toBe(1);
  });

  it('http link', () => {
    expect(countExternalLinks('[text](http://example.com)')).toBe(1);
  });

  it('no links', () => {
    expect(countExternalLinks('No links')).toBe(0);
  });
});

describe('countFootnoteRefs', () => {
  it('counts unique footnote references', () => {
    const content = 'Some text[^1] and more[^2] and again[^1]';
    expect(countFootnoteRefs(content)).toBe(2); // [^1] and [^2], deduped
  });

  it('skips footnote definitions', () => {
    const content = `Some text[^1] and more[^2]

[^1]: https://example.com
[^2]: https://example.org`;
    expect(countFootnoteRefs(content)).toBe(2);
  });

  it('returns 0 for content with only definitions', () => {
    const content = `[^1]: https://example.com
[^2]: https://example.org`;
    expect(countFootnoteRefs(content)).toBe(0);
  });

  it('returns 0 for no footnotes', () => {
    expect(countFootnoteRefs('Just regular text with [links](https://example.com)')).toBe(0);
  });

  it('handles many footnotes', () => {
    const content = 'A[^1] B[^2] C[^3] D[^4] E[^5] F[^6] G[^7] H[^8] I[^9] J[^10]';
    expect(countFootnoteRefs(content)).toBe(10);
  });
});

describe('suggestQuality', () => {
  it('score 0 gives quality 0', () => {
    expect(suggestQuality(0)).toBe(0);
  });

  it('score 15 gives quality 100', () => {
    expect(suggestQuality(15)).toBe(100);
  });

  it('caps stub pages at 35', () => {
    const quality = suggestQuality(10, { pageType: 'stub' });
    expect(quality).toBeLessThanOrEqual(35);
  });

  it('mid-range score', () => {
    const quality = suggestQuality(7);
    expect(quality).toBeGreaterThanOrEqual(40);
    expect(quality).toBeLessThanOrEqual(55);
  });
});

describe('article scoring — section depth', () => {
  it('prose-heavy page with h3 subsections scores ≥40 normalized without tables/diagrams', () => {
    // Simulates a page like trust-cascade: 2000+ words, 15+ citations, 4+ h3s, no tables/diagrams
    const sections = Array.from({ length: 5 }, (_, i) => `
### Subsection ${i + 1}

${'This is a detailed paragraph about AI safety topics with enough words to be substantial. '.repeat(12)}[^${i + 1}]
`).join('\n');
    const content = `---
title: "Prose-Heavy Page"
---

## Overview

This page discusses important AI safety concepts in depth with thorough analysis and citations.[^10]

## Background

A detailed background section covering the history and context of the topic with proper sourcing.[^11]

${sections}

## Key Analysis

More analysis with <EntityLink id="E1">entity links</EntityLink> and [internal links](/page1) and [more](/page2) and [even more](/page3) and [links](/page4).[^12]

## Implications

The implications are significant for the field.[^13] Further research is needed.[^14] Multiple perspectives exist.[^15]

[^1]: Source 1 (https://example.com/1)
[^2]: Source 2 (https://example.com/2)
[^3]: Source 3 (https://example.com/3)
[^4]: Source 4 (https://example.com/4)
[^5]: Source 5 (https://example.com/5)
[^10]: Source 10 (https://example.com/10)
[^11]: Source 11 (https://example.com/11)
[^12]: Source 12 (https://example.com/12)
[^13]: Source 13 (https://example.com/13)
[^14]: Source 14 (https://example.com/14)
[^15]: Source 15 (https://example.com/15)
`;
    const metrics = extractMetrics(content);
    // Should score well despite no tables/diagrams
    expect(metrics.structuralScoreNormalized).toBeGreaterThanOrEqual(40);
    expect(metrics.tableCount).toBe(0);
    expect(metrics.diagramCount).toBe(0);
    expect(metrics.sectionCount.h3).toBeGreaterThanOrEqual(4);
  });

  it('h3 subsections contribute to article score', () => {
    const base = `---
title: Test
---

## Overview

Some overview content here.

`;
    // Page with 0 h3s
    const noH3 = base + 'Just content without subsections.';
    // Page with 4+ h3s
    const withH3 = base + `
### Sub 1
Content here.
### Sub 2
Content here.
### Sub 3
Content here.
### Sub 4
Content here.
`;
    const metricsNoH3 = extractMetrics(noH3);
    const metricsWithH3 = extractMetrics(withH3);
    // The page with h3s should score higher
    expect(metricsWithH3.structuralScore).toBeGreaterThan(metricsNoH3.structuralScore);
  });
});

describe('extractMetrics (integration)', () => {
  it('full content', () => {
    const content = `---
title: Test
---

## Overview

This is a test article with some content here.

| Header | Value |
| --- | --- |
| One | Two |

[Link](/page) and [external](https://example.com)

<EntityLink id="test">Test</EntityLink>
`;
    const metrics = extractMetrics(content);
    expect(metrics.wordCount).toBeGreaterThan(0);
    expect(metrics.tableCount).toBe(1);
    expect(metrics.hasOverview).toBe(true);
    expect(metrics.structuralScore).toBeGreaterThanOrEqual(0);
    expect(metrics.footnoteCount).toBe(0);
  });

  it('counts footnotes in full content', () => {
    const content = `---
title: Test
---

## Overview

AI safety is important[^1] and growing[^2].

[^1]: [Source](https://example.com)
[^2]: [Source](https://example.org)
`;
    const metrics = extractMetrics(content);
    expect(metrics.footnoteCount).toBe(2);
    expect(metrics.externalLinks).toBe(2); // footnote definition links
  });
});
