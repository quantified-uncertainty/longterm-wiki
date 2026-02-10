#!/usr/bin/env node
/**
 * Unit Tests for Shared Library Modules
 *
 * Run: node scripts/lib/lib.test.ts
 */

import { findMdxFiles, findFiles, getDirectories } from './file-utils.ts';
import {
  parseFrontmatter,
  getContentBody,
  hasFrontmatter,
  extractH2Sections,
  extractHeadings,
  countWords,
  extractLinks,
} from './mdx-utils.ts';
import { getColors, createLogger, formatPath, formatCount } from './output.ts';
import {
  CONTENT_TYPES,
  getContentType,
  getStalenessThreshold,
  isIndexPage,
  extractEntityId,
  CONTENT_DIR,
} from './content-types.js';

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

// =============================================================================
// file-utils.mjs tests
// =============================================================================

console.log('\n📁 file-utils.mjs');

test('findMdxFiles returns array', () => {
  const result = findMdxFiles('content/docs/knowledge-base/models');
  assert(Array.isArray(result), 'Should return array');
  assert(result.length > 0, 'Should find files');
  assert(result.every((f: string) => f.endsWith('.mdx') || f.endsWith('.md')), 'Should only find MDX/MD files');
});

test('findMdxFiles handles non-existent directory', () => {
  const result = findMdxFiles('/nonexistent/path');
  assert(Array.isArray(result), 'Should return array');
  assertEqual(result.length, 0, 'Should return empty array');
});

test('findFiles with extensions filter', () => {
  const result = findFiles('data', ['.yaml', '.yml']);
  assert(Array.isArray(result), 'Should return array');
  assert(result.length > 0, 'Should find YAML files');
  assert(result.every((f: string) => f.endsWith('.yaml') || f.endsWith('.yml')), 'Should only find YAML files');
});

test('getDirectories returns directories', () => {
  const result = getDirectories('content/docs/knowledge-base');
  assert(Array.isArray(result), 'Should return array');
  assert(result.length > 0, 'Should find directories');
});

// =============================================================================
// mdx-utils.mjs tests
// =============================================================================

console.log('\n📝 mdx-utils.mjs');

const sampleMdx = `---
title: Test Page
description: A test description
quality: 3
---

## Overview

This is the overview section.

## Key Points

Some key points here.

### Subsection

A subsection with [a link](/path/to/page).
`;

test('parseFrontmatter extracts YAML', () => {
  const result = parseFrontmatter(sampleMdx);
  assertEqual(result.title, 'Test Page');
  assertEqual(result.description, 'A test description');
  assertEqual(result.quality, 3);
});

test('parseFrontmatter handles missing frontmatter', () => {
  const result = parseFrontmatter('Just content, no frontmatter');
  assert(typeof result === 'object', 'Should return object');
  assertEqual(Object.keys(result).length, 0, 'Should be empty');
});

test('getContentBody removes frontmatter', () => {
  const result = getContentBody(sampleMdx);
  assert(!result.includes('---'), 'Should not contain frontmatter delimiters');
  assert(result.includes('## Overview'), 'Should contain body content');
});

test('hasFrontmatter detects frontmatter', () => {
  assert(hasFrontmatter(sampleMdx) === true, 'Should detect frontmatter');
  assert(hasFrontmatter('No frontmatter') === false, 'Should detect missing frontmatter');
});

test('extractH2Sections finds h2 headings', () => {
  const body = getContentBody(sampleMdx);
  const sections = extractH2Sections(body);
  assertEqual(sections.length, 2, 'Should find 2 h2 sections');
  assertEqual(sections[0].title, 'Overview');
  assertEqual(sections[1].title, 'Key Points');
});

test('extractHeadings finds all headings', () => {
  const body = getContentBody(sampleMdx);
  const headings = extractHeadings(body);
  assertEqual(headings.length, 3, 'Should find 3 headings');
  assert(headings.some((h: any) => h.level === 2 && h.title === 'Overview'));
  assert(headings.some((h: any) => h.level === 3 && h.title === 'Subsection'));
});

test('countWords counts correctly', () => {
  const body = 'One two three four five.';
  assertEqual(countWords(body), 5);
});

test('countWords excludes code blocks', () => {
  const body = 'Real words here.\n```\ncode block content\n```\nMore words.';
  const count = countWords(body);
  assert(count < 10, 'Should not count code block words');
});

test('extractLinks finds markdown links', () => {
  const body = getContentBody(sampleMdx);
  const links = extractLinks(body);
  assertEqual(links.length, 1);
  assertEqual(links[0].url, '/path/to/page');
  assertEqual(links[0].text, 'a link');
});

// =============================================================================
// output.mjs tests
// =============================================================================

console.log('\n🎨 output.mjs');

test('getColors returns color object', () => {
  const colors = getColors(false);
  assert('red' in colors, 'Should have red');
  assert('green' in colors, 'Should have green');
  assert('reset' in colors, 'Should have reset');
  assert(colors.red.length > 0, 'Colors should have escape codes');
});

test('getColors returns empty in CI mode', () => {
  const colors = getColors(true);
  assertEqual(colors.red, '', 'CI mode should have empty colors');
  assertEqual(colors.green, '', 'CI mode should have empty colors');
});

test('createLogger returns logger object', () => {
  const logger = createLogger(true);
  assert(typeof logger.log === 'function');
  assert(typeof logger.error === 'function');
  assert(typeof logger.formatIssue === 'function');
});

test('formatPath removes cwd prefix', () => {
  const result = formatPath(process.cwd() + '/src/test.js');
  assertEqual(result, 'src/test.js');
});

test('formatCount pluralizes correctly', () => {
  assertEqual(formatCount(1, 'file'), '1 file');
  assertEqual(formatCount(2, 'file'), '2 files');
  assertEqual(formatCount(0, 'file'), '0 files');
  assertEqual(formatCount(2, 'entry', 'entries'), '2 entries');
});

// =============================================================================
// content-types.js tests
// =============================================================================

console.log('\n📋 content-types.js');

test('CONTENT_TYPES has expected types', () => {
  assert('model' in CONTENT_TYPES);
  assert('risk' in CONTENT_TYPES);
  assert('response' in CONTENT_TYPES);
});

test('getContentType identifies paths correctly', () => {
  assertEqual(getContentType('/path/to/models/some-model.mdx'), 'model');
  assertEqual(getContentType('/path/to/risks/some-risk.mdx'), 'risk');
  assertEqual(getContentType('/path/to/responses/some-response.mdx'), 'response');
  assertEqual(getContentType('/path/to/other/page.mdx'), null);
});

test('getStalenessThreshold returns thresholds', () => {
  const modelThreshold = getStalenessThreshold('model');
  const riskThreshold = getStalenessThreshold('risk');
  assert(typeof modelThreshold === 'number');
  assert(typeof riskThreshold === 'number');
  assertEqual(modelThreshold, 90);
  assertEqual(riskThreshold, 60);
});

test('isIndexPage detects index files', () => {
  assert(isIndexPage('/path/to/index.mdx') === true);
  assert(isIndexPage('/path/to/index.md') === true);
  assert(isIndexPage('/path/to/other.mdx') === false);
});

test('extractEntityId extracts filename', () => {
  assertEqual(extractEntityId('/path/to/deceptive-alignment.mdx'), 'deceptive-alignment');
  assertEqual(extractEntityId('/path/to/index.mdx'), null);
});

test('CONTENT_DIR is set correctly', () => {
  assertEqual(CONTENT_DIR, 'content/docs');
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
