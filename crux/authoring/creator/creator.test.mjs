#!/usr/bin/env node
/**
 * Unit Tests for Page Creator Sub-Modules
 *
 * Tests pure-logic functions extracted during the refactoring.
 * Run: node crux/authoring/creator/creator.test.mjs
 */

import { levenshteinDistance, similarity, toSlug } from './duplicate-detection.mjs';
import { extractUrls } from './source-fetching.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`✗ ${name}`);
    console.log(`  ${e.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ─── Duplicate Detection Tests ───

console.log('\n=== Duplicate Detection ===\n');

test('levenshteinDistance: identical strings', () => {
  assertEqual(levenshteinDistance('hello', 'hello'), 0);
});

test('levenshteinDistance: one substitution', () => {
  assertEqual(levenshteinDistance('hello', 'hallo'), 1);
});

test('levenshteinDistance: one insertion', () => {
  assertEqual(levenshteinDistance('hello', 'helloo'), 1);
});

test('levenshteinDistance: one deletion', () => {
  assertEqual(levenshteinDistance('hello', 'helo'), 1);
});

test('levenshteinDistance: empty strings', () => {
  assertEqual(levenshteinDistance('', ''), 0);
  assertEqual(levenshteinDistance('abc', ''), 3);
  assertEqual(levenshteinDistance('', 'abc'), 3);
});

test('similarity: identical strings', () => {
  assertEqual(similarity('hello', 'hello'), 1);
});

test('similarity: case insensitive', () => {
  assertEqual(similarity('Hello', 'hello'), 1);
});

test('similarity: returns 0-1 range', () => {
  const sim = similarity('abc', 'xyz');
  assert(sim >= 0 && sim <= 1, `Similarity ${sim} not in [0, 1]`);
});

test('similarity: similar strings have high score', () => {
  const sim = similarity('OpenAI', 'OpenAi');
  assert(sim >= 0.8, `Expected >= 0.8, got ${sim}`);
});

test('similarity: very different strings have low score', () => {
  const sim = similarity('apple', 'bicycle');
  assert(sim < 0.5, `Expected < 0.5, got ${sim}`);
});

test('toSlug: basic conversion', () => {
  assertEqual(toSlug('Hello World'), 'hello-world');
});

test('toSlug: special characters', () => {
  assertEqual(toSlug("Open Philanthropy's Fund"), 'open-philanthropy-s-fund');
});

test('toSlug: trims dashes', () => {
  assertEqual(toSlug('--hello--'), 'hello');
});

test('toSlug: handles numbers', () => {
  assertEqual(toSlug('80000 Hours'), '80000-hours');
});

// ─── URL Extraction Tests ───

console.log('\n=== URL Extraction ===\n');

test('extractUrls: basic URL', () => {
  const urls = extractUrls('Check out https://example.com for more');
  assertEqual(urls.length, 1);
  assertEqual(urls[0], 'https://example.com');
});

test('extractUrls: multiple URLs', () => {
  const urls = extractUrls('See https://a.com and http://b.com');
  assertEqual(urls.length, 2);
});

test('extractUrls: strips trailing punctuation', () => {
  const urls = extractUrls('Visit https://example.com.');
  assertEqual(urls[0], 'https://example.com');
});

test('extractUrls: handles trailing comma', () => {
  const urls = extractUrls('Visit https://example.com, for more');
  assertEqual(urls[0], 'https://example.com');
});

test('extractUrls: handles unbalanced parens', () => {
  const urls = extractUrls('(see https://example.com/path)');
  assertEqual(urls[0], 'https://example.com/path');
});

test('extractUrls: preserves balanced parens in URL', () => {
  const urls = extractUrls('https://en.wikipedia.org/wiki/Test_(computing)');
  assertEqual(urls[0], 'https://en.wikipedia.org/wiki/Test_(computing)');
});

test('extractUrls: no URLs returns empty', () => {
  const urls = extractUrls('No links here');
  assertEqual(urls.length, 0);
});

// ─── Summary ───

console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
