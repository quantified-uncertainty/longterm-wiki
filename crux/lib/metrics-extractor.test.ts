#!/usr/bin/env node
/**
 * Unit Tests for Metrics Extractor
 *
 * Tests the newly-exported counting functions.
 * Run: node crux/lib/metrics-extractor.test.ts
 */

import {
  extractMetrics,
  countWords,
  countTables,
  countDiagrams,
  countInternalLinks,
  countExternalLinks,
  suggestQuality,
} from './metrics-extractor.mjs';

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
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ─── countWords ───

console.log('\n=== countWords ===\n');

test('countWords: basic word count', () => {
  const count = countWords('Hello world this is a test');
  assertEqual(count, 6);
});

test('countWords: excludes code blocks', () => {
  const count = countWords('Word one\n```\ncode here not counted\n```\nWord two');
  // Should count 'Word one' and 'Word two' = 4 words, not the code
  assert(count < 10, `Expected fewer words without code, got ${count}`);
});

test('countWords: empty content', () => {
  assertEqual(countWords(''), 0);
});

test('countWords: handles JSX components', () => {
  const count = countWords('Before <Mermaid chart={`graph TD`} /> After');
  // Should count Before and After but not the component
  assert(count <= 4, `Expected <= 4 words, got ${count}`);
});

// ─── countTables ───

console.log('\n=== countTables ===\n');

test('countTables: single table', () => {
  const content = `| Header | Header |
| --- | --- |
| Cell | Cell |`;
  assertEqual(countTables(content), 1);
});

test('countTables: no tables', () => {
  assertEqual(countTables('Just some text'), 0);
});

test('countTables: two tables', () => {
  const content = `| H1 | H2 |
| --- | --- |
| A | B |

Some text

| H3 | H4 |
| --- | --- |
| C | D |`;
  assertEqual(countTables(content), 2);
});

// ─── countDiagrams ───

console.log('\n=== countDiagrams ===\n');

test('countDiagrams: Mermaid component', () => {
  const content = '<Mermaid chart={`graph TD`} />';
  assertEqual(countDiagrams(content), 1);
});

test('countDiagrams: mermaid code block', () => {
  const content = '```mermaid\ngraph TD\n```';
  assertEqual(countDiagrams(content), 1);
});

test('countDiagrams: no diagrams', () => {
  assertEqual(countDiagrams('Just text'), 0);
});

test('countDiagrams: multiple diagrams', () => {
  const content = '<Mermaid chart={`graph TD`} />\n\n```mermaid\ngraph LR\n```';
  assertEqual(countDiagrams(content), 2);
});

// ─── countInternalLinks ───

console.log('\n=== countInternalLinks ===\n');

test('countInternalLinks: markdown link', () => {
  assertEqual(countInternalLinks('[text](/some-page)'), 1);
});

test('countInternalLinks: EntityLink', () => {
  assertEqual(countInternalLinks('<EntityLink id="test">Text</EntityLink>'), 1);
});

test('countInternalLinks: R component', () => {
  assertEqual(countInternalLinks('<R id="ref-1" />'), 1);
});

test('countInternalLinks: mixed', () => {
  const content = '[link](/page) and <EntityLink id="x">X</EntityLink> and <R id="y" />';
  assertEqual(countInternalLinks(content), 3);
});

// ─── countExternalLinks ───

console.log('\n=== countExternalLinks ===\n');

test('countExternalLinks: https link', () => {
  assertEqual(countExternalLinks('[text](https://example.com)'), 1);
});

test('countExternalLinks: http link', () => {
  assertEqual(countExternalLinks('[text](http://example.com)'), 1);
});

test('countExternalLinks: no links', () => {
  assertEqual(countExternalLinks('No links'), 0);
});

// ─── suggestQuality ───

console.log('\n=== suggestQuality ===\n');

test('suggestQuality: score 0 gives quality 0', () => {
  assertEqual(suggestQuality(0), 0);
});

test('suggestQuality: score 15 gives quality 100', () => {
  assertEqual(suggestQuality(15), 100);
});

test('suggestQuality: caps stub pages at 35', () => {
  const quality = suggestQuality(10, { pageType: 'stub' });
  assert(quality <= 35, `Expected <= 35 for stub, got ${quality}`);
});

test('suggestQuality: mid-range score', () => {
  const quality = suggestQuality(7);
  assert(quality >= 40 && quality <= 55, `Expected 40-55, got ${quality}`);
});

// ─── extractMetrics (integration) ───

console.log('\n=== extractMetrics (integration) ===\n');

test('extractMetrics: full content', () => {
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
  assert(metrics.wordCount > 0, `Expected wordCount > 0, got ${metrics.wordCount}`);
  assertEqual(metrics.tableCount, 1);
  assert(metrics.hasOverview, 'Expected hasOverview to be true');
  assert(metrics.structuralScore >= 0, `Expected structuralScore >= 0`);
});

// ─── Summary ───

console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
