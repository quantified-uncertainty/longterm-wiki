import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { extractMetrics, suggestQuality, getQualityDiscrepancy } from './metrics-extractor.ts';

// =============================================================================
// Validator scripts exist
// =============================================================================

describe('Validator scripts exist', () => {
  const validatorScripts: string[] = [
    'crux/validate/validate-all.ts',
    'crux/validate/validate-data.ts',
    'crux/validate/validate-internal-links.ts',
    'crux/validate/validate-mdx-syntax.ts',
    'crux/validate/validate-style-guide.ts',
    'crux/validate/validate-consistency.ts',
    'crux/validate/check-staleness.ts',
    'crux/validate/validate-sidebar.ts',
  ];

  for (const script of validatorScripts) {
    it(`${script} exists`, () => {
      expect(existsSync(script)).toBe(true);
    });
  }
});

// =============================================================================
// metrics-extractor.ts tests
// =============================================================================

describe('metrics-extractor.ts', () => {
  const sampleQ1Content = `---
title: Stub Page
---

## Overview

Brief content.
`;

  const sampleQ5Content = `---
title: Excellent Page
quality: 5
---

## Overview

This is a comprehensive page with detailed analysis of the topic. The content spans multiple paragraphs and provides thorough coverage of all relevant aspects. We examine the evidence from various perspectives and synthesize findings from multiple sources.

| Category | Value | Source |
|----------|-------|--------|
| Impact | High | [Smith 2023](https://example.com) |
| Likelihood | Medium | [Jones 2024](https://example.com) |
| Timeline | 2025-2030 | Expert consensus |

## Quantitative Analysis

The model estimates a 30-50% probability based on the following factors:

| Factor | Weight | Confidence |
|--------|--------|------------|
| Historical precedent | 0.3 | High |
| Current trends | 0.4 | Medium |
| Expert opinion | 0.3 | Medium |

<Mermaid client:load chart={\`
flowchart TD
    A[Input] --> B[Process]
    B --> C[Output]
\`} />

## Key References

See [Research Paper](https://example.com/paper) and [Government Report](https://example.gov/report) for more details.

## Limitations

This analysis has several limitations that should be considered.

## Conclusion

Based on the evidence, we conclude that the risk is significant but manageable.
`;

  it('extractMetrics returns valid structure', () => {
    const metrics = extractMetrics(sampleQ1Content);
    expect('wordCount' in metrics).toBe(true);
    expect('tableCount' in metrics).toBe(true);
    expect('diagramCount' in metrics).toBe(true);
    expect('structuralScore' in metrics).toBe(true);
  });

  it('extractMetrics counts words correctly', () => {
    const metrics = extractMetrics(sampleQ1Content);
    expect(metrics.wordCount > 0).toBe(true);
    expect(metrics.wordCount < 20).toBe(true);
  });

  it('extractMetrics detects tables', () => {
    const metrics = extractMetrics(sampleQ5Content);
    expect(metrics.tableCount).toBe(2);
  });

  it('extractMetrics detects Mermaid diagrams', () => {
    const metrics = extractMetrics(sampleQ5Content);
    expect(metrics.diagramCount).toBe(1);
  });

  it('extractMetrics detects links', () => {
    const metrics = extractMetrics(sampleQ5Content);
    expect(metrics.externalLinks >= 4).toBe(true);
  });

  it('extractMetrics detects overview section', () => {
    const metricsQ1 = extractMetrics(sampleQ1Content);
    const metricsQ5 = extractMetrics(sampleQ5Content);
    expect(metricsQ1.hasOverview).toBe(true);
    expect(metricsQ5.hasOverview).toBe(true);
  });

  it('extractMetrics detects conclusion', () => {
    const metricsQ1 = extractMetrics(sampleQ1Content);
    const metricsQ5 = extractMetrics(sampleQ5Content);
    expect(metricsQ1.hasConclusion).toBe(false);
    expect(metricsQ5.hasConclusion).toBe(true);
  });

  it('structuralScore is higher for better content', () => {
    const metricsQ1 = extractMetrics(sampleQ1Content);
    const metricsQ5 = extractMetrics(sampleQ5Content);
    expect(metricsQ5.structuralScore > metricsQ1.structuralScore).toBe(true);
  });

  it('structuralScoreNormalized is 0-50', () => {
    const metrics = extractMetrics(sampleQ5Content);
    expect(metrics.structuralScoreNormalized).toBeGreaterThanOrEqual(0);
    expect(metrics.structuralScoreNormalized).toBeLessThanOrEqual(50);
  });
});

// =============================================================================
// suggestQuality tests
// =============================================================================

describe('suggestQuality', () => {
  it('suggestQuality returns 0-100', () => {
    for (let score = 0; score <= 15; score++) {
      const quality = suggestQuality(score);
      expect(quality).toBeGreaterThanOrEqual(0);
      expect(quality).toBeLessThanOrEqual(100);
    }
  });

  it('suggestQuality increases with score', () => {
    const q0 = suggestQuality(0);
    const q6 = suggestQuality(6);
    const q12 = suggestQuality(12);
    expect(q12 >= q6).toBe(true);
    expect(q6 >= q0).toBe(true);
  });

  it('suggestQuality maps scores linearly', () => {
    // Score 0 → 0%, Score 15 → 100%
    expect(suggestQuality(0)).toBe(0);
    expect(suggestQuality(15)).toBe(100);
    // Middle score maps proportionally
    expect(suggestQuality(7)).toBe(Math.round((7 / 15) * 100)); // ~47
    expect(suggestQuality(10)).toBe(Math.round((10 / 15) * 100)); // ~67
  });
});

// =============================================================================
// getQualityDiscrepancy tests
// =============================================================================

describe('getQualityDiscrepancy', () => {
  it('getQualityDiscrepancy returns valid structure', () => {
    const result = getQualityDiscrepancy(40, 6); // current 40%, structural score 6 → suggested 40%
    expect('current' in result).toBe(true);
    expect('suggested' in result).toBe(true);
    expect('discrepancy' in result).toBe(true);
    expect('flag' in result).toBe(true);
  });

  it('getQualityDiscrepancy calculates correctly', () => {
    // current 50%, structural score 3 → suggested 20% (3/15*100)
    const result = getQualityDiscrepancy(50, 3);
    expect(result.current).toBe(50);
    expect(result.suggested).toBe(20);
    expect(result.discrepancy).toBe(30); // 50 - 20 = 30 (overrated)
    expect(result.discrepancy > 0).toBe(true);
  });

  it('getQualityDiscrepancy flags large discrepancies', () => {
    // current 80%, score 0 → suggested 0%, discrepancy 80 → large (>=20)
    const large = getQualityDiscrepancy(80, 0);
    // current 40%, score 6 → suggested 40%, discrepancy 0 → ok
    const small = getQualityDiscrepancy(40, 6);
    expect(large.flag).toBe('large');
    expect(small.flag).toBe('ok');
  });
});

// =============================================================================
// MDX Syntax patterns (from validate-mdx-syntax)
// =============================================================================

describe('MDX syntax validation patterns', () => {
  function testMdxPattern(pattern: RegExp, content: string): boolean {
    return pattern.test(content);
  }

  it('detects mermaid codeblocks', () => {
    const pattern = /^```mermaid/m;
    expect(testMdxPattern(pattern, '```mermaid\nflowchart TD\n```')).toBe(true);
    expect(testMdxPattern(pattern, '<Mermaid chart={`...`} />')).toBe(false);
  });

  it('detects unescaped < in tables', () => {
    const pattern = /\| <[0-9]/;
    expect(testMdxPattern(pattern, '| <30% |')).toBe(true);
    expect(testMdxPattern(pattern, '| less than 30% |')).toBe(false);
  });
});

// =============================================================================
// Link validation patterns (from validate-internal-links)
// =============================================================================

describe('Link validation patterns', () => {
  function extractInternalLinks(content: string): Array<{ text: string; href: string }> {
    const links: Array<{ text: string; href: string }> = [];
    const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(content)) !== null) {
      const [, text, href] = match;
      if (!href.startsWith('http') && !href.startsWith('#') && !href.startsWith('mailto:')) {
        links.push({ text, href });
      }
    }
    return links;
  }

  it('extractInternalLinks finds internal links', () => {
    const content = 'See [this page](/knowledge-base/risks/) for details.';
    const links = extractInternalLinks(content);
    expect(links.length).toBe(1);
    expect(links[0].href).toBe('/knowledge-base/risks/');
  });

  it('extractInternalLinks ignores external links', () => {
    const content = 'See [Google](https://google.com) and [internal](/path/).';
    const links = extractInternalLinks(content);
    expect(links.length).toBe(1);
    expect(links[0].href).toBe('/path/');
  });

  it('extractInternalLinks ignores anchors', () => {
    const content = 'Jump to [section](#overview) or [page](/page/).';
    const links = extractInternalLinks(content);
    expect(links.length).toBe(1);
  });
});

// =============================================================================
// Placeholder validator functions (from validate-placeholders.ts)
// =============================================================================

describe('Placeholder validator helpers', () => {
  // Inline implementations for testing
  function getSectionContent(body: string, sectionName: string): string | null {
    const headerPattern = sectionName === 'Limitations'
      ? /^##\s+Limitations?\s*$/mi
      : new RegExp(`^##\\s+${sectionName}\\s*$`, 'mi');

    const headerMatch = body.match(headerPattern);
    if (!headerMatch) return null;

    const startIndex = headerMatch.index! + headerMatch[0].length;
    const afterHeader = body.slice(startIndex);
    const nextH2Match = afterHeader.match(/\n##\s+[^#]/);
    const endIndex = nextH2Match ? nextH2Match.index! : afterHeader.length;

    return afterHeader.slice(0, endIndex);
  }

  function isInCodeBlock(content: string, position: number): boolean {
    const before = content.slice(0, position);
    const tripleBackticks = (before.match(/```/g) || []).length;
    return tripleBackticks % 2 === 1;
  }

  function isInMermaid(content: string, position: number): boolean {
    const before = content.slice(0, position);
    const lastMermaidOpen = before.lastIndexOf('<Mermaid');
    if (lastMermaidOpen === -1) return false;

    const afterMermaid = content.slice(lastMermaidOpen, position);
    const closingPattern = /`\s*}\s*\/>/;
    const closingMatch = afterMermaid.match(closingPattern);
    return !closingMatch;
  }

  function isInComment(content: string, position: number): boolean {
    const before = content.slice(0, position);
    const opens = (before.match(/<!--/g) || []).length;
    const closes = (before.match(/-->/g) || []).length;
    return opens > closes;
  }

  function getLineNumber(content: string, position: number): number {
    return content.slice(0, position).split('\n').length;
  }

  // getSectionContent tests
  it('getSectionContent extracts simple section', () => {
    const body = `## Overview

This is the overview section.

## Next Section

Different content.`;
    const content = getSectionContent(body, 'Overview');
    expect(content).not.toBeNull();
    expect(content!).toContain('This is the overview section');
    expect(content!).not.toContain('Different content');
  });

  it('getSectionContent handles section at end of document', () => {
    const body = `## First

Some.

## Overview

Last section with no following header.`;
    const content = getSectionContent(body, 'Overview');
    expect(content).not.toBeNull();
    expect(content!).toContain('Last section');
  });

  it('getSectionContent returns null for missing section', () => {
    const body = `## Overview\n\nContent.`;
    expect(getSectionContent(body, 'NonExistent')).toBeNull();
  });

  it('getSectionContent does not match h3 headings', () => {
    const body = `## Overview

Main content.

### Overview Subsection

Subsection content.

## Next

Next content.`;
    const content = getSectionContent(body, 'Overview');
    expect(content!).toContain('Subsection content');
    expect(content!).not.toContain('Next content');
  });

  it('getSectionContent handles Limitation/Limitations variant', () => {
    // The regex makes the 's' optional: Limitations? matches both Limitation and Limitations
    const body1 = `## Limitation\n\nLimits here.\n\n## Next`;
    const body2 = `## Limitations\n\nLimits here.\n\n## Next`;
    expect(getSectionContent(body1, 'Limitations')).not.toBeNull();
    expect(getSectionContent(body2, 'Limitations')).not.toBeNull();
  });

  // isInCodeBlock tests
  it('isInCodeBlock detects position inside code', () => {
    const content = `Text\n\n\`\`\`js\nconst TODO = 1;\n\`\`\`\n\nAfter`;
    const todoPos = content.indexOf('TODO');
    expect(isInCodeBlock(content, todoPos)).toBe(true);
  });

  it('isInCodeBlock detects position outside code', () => {
    const content = `TODO before\n\n\`\`\`js\nconst x = 1;\n\`\`\``;
    const todoPos = content.indexOf('TODO');
    expect(isInCodeBlock(content, todoPos)).toBe(false);
  });

  // isInMermaid tests
  it('isInMermaid detects position inside diagram', () => {
    const content = `<Mermaid client:load chart={\`
graph TD
    A[TBD] --> B
\`} />

After`;
    const tbdPos = content.indexOf('TBD');
    expect(isInMermaid(content, tbdPos)).toBe(true);
  });

  it('isInMermaid detects position outside diagram', () => {
    const content = `<Mermaid client:load chart={\`
graph TD
    A --> B
\`} />

TBD outside`;
    const tbdPos = content.lastIndexOf('TBD');
    expect(isInMermaid(content, tbdPos)).toBe(false);
  });

  it('isInMermaid handles br tags correctly', () => {
    // Regression test: <br/> inside Mermaid was incorrectly closing detection
    const content = `<Mermaid client:load chart={\`
graph TD
    A[Line<br/>TBD]
\`} />`;
    const tbdPos = content.indexOf('TBD');
    expect(isInMermaid(content, tbdPos)).toBe(true);
  });

  it('isInMermaid handles no Mermaid present', () => {
    const content = `Regular TBD content.`;
    const tbdPos = content.indexOf('TBD');
    expect(isInMermaid(content, tbdPos)).toBe(false);
  });

  // isInComment tests
  it('isInComment detects position inside comment', () => {
    const content = `Before\n\n<!-- TODO: fix -->\n\nAfter`;
    const todoPos = content.indexOf('TODO');
    expect(isInComment(content, todoPos)).toBe(true);
  });

  it('isInComment detects position outside comment', () => {
    const content = `TODO outside\n\n<!-- comment -->`;
    const todoPos = content.indexOf('TODO');
    expect(isInComment(content, todoPos)).toBe(false);
  });

  // getLineNumber tests
  it('getLineNumber returns correct line', () => {
    const content = `Line 1\nLine 2\nLine 3 target`;
    expect(getLineNumber(content, content.indexOf('target'))).toBe(3);
  });

  it('getLineNumber handles empty lines', () => {
    const content = `Line 1\n\nLine 3\n\nLine 5 target`;
    expect(getLineNumber(content, content.indexOf('target'))).toBe(5);
  });
});
