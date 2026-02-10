#!/usr/bin/env node
/**
 * Unit Tests for Validators
 *
 * Tests the core validation logic used by the validator scripts.
 * Run: node scripts/lib/validators.test.ts
 */

import { existsSync } from 'fs';
import { extractMetrics, suggestQuality, getQualityDiscrepancy } from './metrics-extractor.ts';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`✗ ${name}`);
    console.log(`  ${e.message}`);
    failed++;
  }
}

function assert(condition: boolean, message?: string): void {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual: unknown, expected: unknown, message?: string): void {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

function assertInRange(value: number, min: number, max: number, message?: string): void {
  if (value < min || value > max) {
    throw new Error(message || `Expected ${value} to be in range [${min}, ${max}]`);
  }
}

// =============================================================================
// Validator scripts exist
// =============================================================================

console.log('\n📁 Validator scripts exist');

const validatorScripts: string[] = [
  'crux/validate/validate-all.mjs',
  'crux/validate/validate-data.mjs',
  'crux/validate/validate-internal-links.mjs',
  'crux/validate/validate-mdx-syntax.mjs',
  'crux/validate/validate-style-guide.mjs',
  'crux/validate/validate-consistency.mjs',
  'crux/validate/check-staleness.mjs',
  'crux/validate/validate-sidebar.mjs',
];

for (const script of validatorScripts) {
  test(`${script} exists`, () => {
    assert(existsSync(script), `Script ${script} should exist`);
  });
}

// =============================================================================
// metrics-extractor.mjs tests
// =============================================================================

console.log('\n📊 metrics-extractor.mjs');

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

test('extractMetrics returns valid structure', () => {
  const metrics = extractMetrics(sampleQ1Content);
  assert('wordCount' in metrics, 'Should have wordCount');
  assert('tableCount' in metrics, 'Should have tableCount');
  assert('diagramCount' in metrics, 'Should have diagramCount');
  assert('structuralScore' in metrics, 'Should have structuralScore');
});

test('extractMetrics counts words correctly', () => {
  const metrics = extractMetrics(sampleQ1Content);
  assert(metrics.wordCount > 0, 'Should count words');
  assert(metrics.wordCount < 20, 'Should have few words in stub');
});

test('extractMetrics detects tables', () => {
  const metrics = extractMetrics(sampleQ5Content);
  assertEqual(metrics.tableCount, 2, 'Should find 2 tables');
});

test('extractMetrics detects Mermaid diagrams', () => {
  const metrics = extractMetrics(sampleQ5Content);
  assertEqual(metrics.diagramCount, 1, 'Should find 1 diagram');
});

test('extractMetrics detects links', () => {
  const metrics = extractMetrics(sampleQ5Content);
  assert(metrics.externalLinks >= 4, 'Should find external links');
});

test('extractMetrics detects overview section', () => {
  const metricsQ1 = extractMetrics(sampleQ1Content);
  const metricsQ5 = extractMetrics(sampleQ5Content);
  assertEqual(metricsQ1.hasOverview, true, 'Q1 should have overview');
  assertEqual(metricsQ5.hasOverview, true, 'Q5 should have overview');
});

test('extractMetrics detects conclusion', () => {
  const metricsQ1 = extractMetrics(sampleQ1Content);
  const metricsQ5 = extractMetrics(sampleQ5Content);
  assertEqual(metricsQ1.hasConclusion, false, 'Q1 should not have conclusion');
  assertEqual(metricsQ5.hasConclusion, true, 'Q5 should have conclusion');
});

test('structuralScore is higher for better content', () => {
  const metricsQ1 = extractMetrics(sampleQ1Content);
  const metricsQ5 = extractMetrics(sampleQ5Content);
  assert(metricsQ5.structuralScore > metricsQ1.structuralScore,
    `Q5 score (${metricsQ5.structuralScore}) should be higher than Q1 (${metricsQ1.structuralScore})`);
});

test('structuralScoreNormalized is 0-50', () => {
  const metrics = extractMetrics(sampleQ5Content);
  assertInRange(metrics.structuralScoreNormalized, 0, 50, 'Normalized score should be 0-50');
});

// =============================================================================
// suggestQuality tests
// =============================================================================

console.log('\n⭐ suggestQuality');

test('suggestQuality returns 0-100', () => {
  for (let score = 0; score <= 15; score++) {
    const quality = suggestQuality(score);
    assertInRange(quality, 0, 100, `Quality for score ${score} should be 0-100`);
  }
});

test('suggestQuality increases with score', () => {
  const q0 = suggestQuality(0);
  const q6 = suggestQuality(6);
  const q12 = suggestQuality(12);
  assert(q12 >= q6, 'Higher scores should suggest higher quality');
  assert(q6 >= q0, 'Higher scores should suggest higher quality');
});

test('suggestQuality maps scores linearly', () => {
  // Score 0 → 0%, Score 15 → 100%
  assertEqual(suggestQuality(0), 0);
  assertEqual(suggestQuality(15), 100);
  // Middle score maps proportionally
  assertEqual(suggestQuality(7), Math.round((7 / 15) * 100)); // ~47
  assertEqual(suggestQuality(10), Math.round((10 / 15) * 100)); // ~67
});

// =============================================================================
// getQualityDiscrepancy tests
// =============================================================================

console.log('\n📉 getQualityDiscrepancy');

test('getQualityDiscrepancy returns valid structure', () => {
  const result = getQualityDiscrepancy(40, 6); // current 40%, structural score 6 → suggested 40%
  assert('current' in result, 'Should have current');
  assert('suggested' in result, 'Should have suggested');
  assert('discrepancy' in result, 'Should have discrepancy');
  assert('flag' in result, 'Should have flag');
});

test('getQualityDiscrepancy calculates correctly', () => {
  // current 50%, structural score 3 → suggested 20% (3/15*100)
  const result = getQualityDiscrepancy(50, 3);
  assertEqual(result.current, 50);
  assertEqual(result.suggested, 20);
  assertEqual(result.discrepancy, 30); // 50 - 20 = 30 (overrated)
  assert(result.discrepancy > 0, 'Should have positive discrepancy (overrated)');
});

test('getQualityDiscrepancy flags large discrepancies', () => {
  // current 80%, score 0 → suggested 0%, discrepancy 80 → large (>=20)
  const large = getQualityDiscrepancy(80, 0);
  // current 40%, score 6 → suggested 40%, discrepancy 0 → ok
  const small = getQualityDiscrepancy(40, 6);
  assertEqual(large.flag, 'large', 'Large gap should be flagged');
  assertEqual(small.flag, 'ok', 'Small gap should be ok');
});

// =============================================================================
// MDX Syntax patterns (from validate-mdx-syntax)
// =============================================================================

console.log('\n🔍 MDX syntax validation patterns');

function testMdxPattern(pattern: RegExp, content: string): boolean {
  return pattern.test(content);
}

test('detects mermaid codeblocks', () => {
  const pattern = /^```mermaid/m;
  assert(testMdxPattern(pattern, '```mermaid\nflowchart TD\n```'), 'Should detect mermaid codeblock');
  assert(!testMdxPattern(pattern, '<Mermaid chart={`...`} />'), 'Should not detect Mermaid component');
});

test('detects unescaped < in tables', () => {
  const pattern = /\| <[0-9]/;
  assert(testMdxPattern(pattern, '| <30% |'), 'Should detect <30% in table');
  assert(!testMdxPattern(pattern, '| less than 30% |'), 'Should not flag "less than"');
});

// =============================================================================
// Link validation patterns (from validate-internal-links)
// =============================================================================

console.log('\n🔗 Link validation patterns');

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

test('extractInternalLinks finds internal links', () => {
  const content = 'See [this page](/knowledge-base/risks/) for details.';
  const links = extractInternalLinks(content);
  assertEqual(links.length, 1);
  assertEqual(links[0].href, '/knowledge-base/risks/');
});

test('extractInternalLinks ignores external links', () => {
  const content = 'See [Google](https://google.com) and [internal](/path/).';
  const links = extractInternalLinks(content);
  assertEqual(links.length, 1);
  assertEqual(links[0].href, '/path/');
});

test('extractInternalLinks ignores anchors', () => {
  const content = 'Jump to [section](#overview) or [page](/page/).';
  const links = extractInternalLinks(content);
  assertEqual(links.length, 1);
});

// =============================================================================
// Placeholder validator functions (from validate-placeholders.mjs)
// =============================================================================

console.log('\n📝 Placeholder validator helpers');

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
test('getSectionContent extracts simple section', () => {
  const body = `## Overview

This is the overview section.

## Next Section

Different content.`;
  const content = getSectionContent(body, 'Overview');
  assert(content !== null, 'Should find section');
  assert(content!.includes('This is the overview section'), 'Should include content');
  assert(!content!.includes('Different content'), 'Should not include next section');
});

test('getSectionContent handles section at end of document', () => {
  const body = `## First

Some.

## Overview

Last section with no following header.`;
  const content = getSectionContent(body, 'Overview');
  assert(content !== null, 'Should find section');
  assert(content!.includes('Last section'), 'Should include content');
});

test('getSectionContent returns null for missing section', () => {
  const body = `## Overview\n\nContent.`;
  assertEqual(getSectionContent(body, 'NonExistent'), null);
});

test('getSectionContent does not match h3 headings', () => {
  const body = `## Overview

Main content.

### Overview Subsection

Subsection content.

## Next

Next content.`;
  const content = getSectionContent(body, 'Overview');
  assert(content!.includes('Subsection content'), 'Should include h3 content');
  assert(!content!.includes('Next content'), 'Should stop at h2');
});

test('getSectionContent handles Limitation/Limitations variant', () => {
  // The regex makes the 's' optional: Limitations? matches both Limitation and Limitations
  const body1 = `## Limitation\n\nLimits here.\n\n## Next`;
  const body2 = `## Limitations\n\nLimits here.\n\n## Next`;
  assert(getSectionContent(body1, 'Limitations') !== null, 'Should find Limitation (singular)');
  assert(getSectionContent(body2, 'Limitations') !== null, 'Should find Limitations (plural)');
});

// isInCodeBlock tests
test('isInCodeBlock detects position inside code', () => {
  const content = `Text\n\n\`\`\`js\nconst TODO = 1;\n\`\`\`\n\nAfter`;
  const todoPos = content.indexOf('TODO');
  assert(isInCodeBlock(content, todoPos), 'TODO inside code should be detected');
});

test('isInCodeBlock detects position outside code', () => {
  const content = `TODO before\n\n\`\`\`js\nconst x = 1;\n\`\`\``;
  const todoPos = content.indexOf('TODO');
  assert(!isInCodeBlock(content, todoPos), 'TODO outside code should not be detected');
});

// isInMermaid tests
test('isInMermaid detects position inside diagram', () => {
  const content = `<Mermaid client:load chart={\`
graph TD
    A[TBD] --> B
\`} />

After`;
  const tbdPos = content.indexOf('TBD');
  assert(isInMermaid(content, tbdPos), 'TBD inside Mermaid should be detected');
});

test('isInMermaid detects position outside diagram', () => {
  const content = `<Mermaid client:load chart={\`
graph TD
    A --> B
\`} />

TBD outside`;
  const tbdPos = content.lastIndexOf('TBD');
  assert(!isInMermaid(content, tbdPos), 'TBD outside Mermaid should not be detected');
});

test('isInMermaid handles br tags correctly', () => {
  // Regression test: <br/> inside Mermaid was incorrectly closing detection
  const content = `<Mermaid client:load chart={\`
graph TD
    A[Line<br/>TBD]
\`} />`;
  const tbdPos = content.indexOf('TBD');
  assert(isInMermaid(content, tbdPos), 'TBD after <br/> should still be inside Mermaid');
});

test('isInMermaid handles no Mermaid present', () => {
  const content = `Regular TBD content.`;
  const tbdPos = content.indexOf('TBD');
  assert(!isInMermaid(content, tbdPos), 'Should return false when no Mermaid');
});

// isInComment tests
test('isInComment detects position inside comment', () => {
  const content = `Before\n\n<!-- TODO: fix -->\n\nAfter`;
  const todoPos = content.indexOf('TODO');
  assert(isInComment(content, todoPos), 'TODO inside comment should be detected');
});

test('isInComment detects position outside comment', () => {
  const content = `TODO outside\n\n<!-- comment -->`;
  const todoPos = content.indexOf('TODO');
  assert(!isInComment(content, todoPos), 'TODO outside comment should not be detected');
});

// getLineNumber tests
test('getLineNumber returns correct line', () => {
  const content = `Line 1\nLine 2\nLine 3 target`;
  assertEqual(getLineNumber(content, content.indexOf('target')), 3);
});

test('getLineNumber handles empty lines', () => {
  const content = `Line 1\n\nLine 3\n\nLine 5 target`;
  assertEqual(getLineNumber(content, content.indexOf('target')), 5);
});

// =============================================================================
// Summary
// =============================================================================

console.log('\n' + '─'.repeat(50));
console.log(`\n✅ Passed: ${passed}`);
if (failed > 0) {
  console.log(`❌ Failed: ${failed}`);
  process.exit(1);
} else {
  console.log('\n🎉 All tests passed!');
}
