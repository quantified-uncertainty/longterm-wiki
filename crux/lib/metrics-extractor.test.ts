import { describe, it, expect } from 'vitest';

import {
  extractMetrics,
  countWords,
  countTables,
  countDiagrams,
  countInternalLinks,
  countExternalLinks,
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
  });
});
