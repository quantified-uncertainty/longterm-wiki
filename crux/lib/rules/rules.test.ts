#!/usr/bin/env node
/**
 * Unit Tests for Validation Rules
 *
 * Tests the CRITICAL and key QUALITY validation rules.
 * Run: node --import tsx/esm crux/lib/rules/rules.test.ts
 */

import { Issue, Severity, FixType, createRule } from '../validation-engine.js';
import { dollarSignsRule } from './dollar-signs.mjs';
import { comparisonOperatorsRule } from './comparison-operators.mjs';
import { tildeDollarRule } from './tilde-dollar.mjs';
import { fakeUrlsRule } from './fake-urls.mjs';
import { placeholdersRule } from './placeholders.mjs';
import { consecutiveBoldLabelsRule } from './consecutive-bold-labels.mjs';
import { temporalArtifactsRule } from './temporal-artifacts.mjs';
import { vagueCitationsRule } from './vague-citations.mjs';

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

/**
 * Create a mock content file for testing rules
 */
function mockContent(body: string, opts: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: opts.path || 'content/docs/test-page.mdx',
    relativePath: opts.relativePath || 'test-page.mdx',
    body,
    frontmatter: opts.frontmatter || { title: 'Test Page' },
    isIndex: opts.isIndex || false,
  };
}

// =============================================================================
// dollar-signs rule
// =============================================================================

console.log('\n💲 dollar-signs rule');

test('detects unescaped $ before numbers', () => {
  const content = mockContent('The cost is $100 per unit.');
  const issues = dollarSignsRule.check(content, {});
  assertEqual(issues.length, 1);
  assert(issues[0].message.includes('Unescaped dollar sign'));
  assertEqual(issues[0].severity, Severity.ERROR);
});

test('allows escaped \\$ before numbers', () => {
  const content = mockContent('The cost is \\$100 per unit.');
  const issues = dollarSignsRule.check(content, {});
  assertEqual(issues.length, 0);
});

test('detects double-escaped \\\\$ in body', () => {
  const content = mockContent('The cost is \\\\$100.');
  const issues = dollarSignsRule.check(content, {});
  // Should detect double-escaped (the regex is /\\\\\$/g which matches literal \\$)
  assert(issues.some((i: any) => i.message.includes('Double-escaped')));
});

test('skips $ in code blocks', () => {
  const content = mockContent('```\n$100\n```');
  const issues = dollarSignsRule.check(content, {});
  assertEqual(issues.length, 0);
});

test('detects multiple $ on same line', () => {
  const content = mockContent('Between $5 and $10.');
  const issues = dollarSignsRule.check(content, {});
  assertEqual(issues.length, 2);
});

// =============================================================================
// comparison-operators rule
// =============================================================================

console.log('\n⚖️  comparison-operators rule');

test('detects unescaped < before numbers', () => {
  const content = mockContent('Response time <10ms is ideal.');
  const issues = comparisonOperatorsRule.check(content, {});
  assertEqual(issues.length, 1);
  assert(issues[0].message.includes('Unescaped'));
  assertEqual(issues[0].severity, Severity.ERROR);
});

test('allows already-escaped &lt;', () => {
  const content = mockContent('Response time &lt;10ms is ideal.');
  const issues = comparisonOperatorsRule.check(content, {});
  assertEqual(issues.length, 0);
});

test('skips < in code blocks', () => {
  const content = mockContent('```\nif (x < 10) {}\n```');
  const issues = comparisonOperatorsRule.check(content, {});
  assertEqual(issues.length, 0);
});

test('does not flag valid HTML/JSX tags', () => {
  const content = mockContent('<div>hello</div>');
  const issues = comparisonOperatorsRule.check(content, {});
  assertEqual(issues.length, 0);
});

// =============================================================================
// tilde-dollar rule
// =============================================================================

console.log('\n〜 tilde-dollar rule');

test('detects ~\\$ pattern', () => {
  const content = mockContent('approximately ~\\$29M in funding.');
  const issues = tildeDollarRule.check(content, {});
  assert(issues.length >= 1);
  assert(issues[0].message.includes('Tilde before escaped dollar'));
  assertEqual(issues[0].severity, Severity.ERROR);
});

test('allows ≈\\$ pattern', () => {
  const content = mockContent('approximately ≈\\$29M in funding.');
  const issues = tildeDollarRule.check(content, {});
  // Should not flag the ≈ version
  const tildeDollarIssues = issues.filter((i: any) => i.message.includes('Tilde before escaped'));
  assertEqual(tildeDollarIssues.length, 0);
});

test('detects tilde before number in table cell', () => {
  const content = mockContent('| Name | Value |\n|---|---|\n| Test | ~86% |');
  const issues = tildeDollarRule.check(content, {});
  assert(issues.length >= 1);
  assert(issues.some((i: any) => i.message.includes('Tilde in table cell')));
});

// =============================================================================
// fake-urls rule
// =============================================================================

console.log('\n🔗 fake-urls rule');

test('detects example.com URLs', () => {
  const content = mockContent('[link](https://example.com/page)');
  const issues = fakeUrlsRule.check(content, {});
  assert(issues.length >= 1);
  assert(issues[0].message.includes('example.com'));
});

test('detects localhost URLs', () => {
  const content = mockContent('[local](http://localhost:3000/test)');
  const issues = fakeUrlsRule.check(content, {});
  assert(issues.length >= 1);
  assert(issues[0].message.includes('localhost'));
});

test('detects placeholder domains', () => {
  const content = mockContent('[test](https://placeholder.com/stuff)');
  const issues = fakeUrlsRule.check(content, {});
  assert(issues.length >= 1);
});

test('does not flag real URLs', () => {
  const content = mockContent('[real](https://arxiv.org/abs/2301.01234)');
  const issues = fakeUrlsRule.check(content, {});
  assertEqual(issues.length, 0);
});

test('skips documentation pages', () => {
  const content = mockContent('[link](https://example.com)', {
    frontmatter: { title: 'Docs', pageType: 'documentation' },
  });
  const issues = fakeUrlsRule.check(content, {});
  assertEqual(issues.length, 0);
});

test('skips stub pages', () => {
  const content = mockContent('[link](https://example.com)', {
    frontmatter: { title: 'Stub', pageType: 'stub' },
  });
  const issues = fakeUrlsRule.check(content, {});
  assertEqual(issues.length, 0);
});

test('skips internal docs', () => {
  const content = mockContent('[link](https://example.com)', {
    relativePath: '/internal/guide.mdx',
  });
  const issues = fakeUrlsRule.check(content, {});
  assertEqual(issues.length, 0);
});

// =============================================================================
// placeholders rule
// =============================================================================

console.log('\n📝 placeholders rule');

test('detects TODO markers', () => {
  const content = mockContent('This section needs TODO: fill in details.');
  const issues = placeholdersRule.check(content, {});
  assert(issues.length >= 1);
  assert(issues.some((i: any) => i.message.includes('TODO')));
});

test('detects Lorem ipsum', () => {
  const content = mockContent('Lorem ipsum dolor sit amet.');
  const issues = placeholdersRule.check(content, {});
  assert(issues.length >= 1);
  assertEqual(issues[0].severity, Severity.ERROR);
});

test('detects bracketed placeholders', () => {
  const content = mockContent('The value is [TBD] and [Value] here.');
  const issues = placeholdersRule.check(content, {});
  assert(issues.length >= 1);
});

test('skips placeholders in code blocks', () => {
  const content = mockContent('```\nTODO: implement this\n```');
  const issues = placeholdersRule.check(content, {});
  assertEqual(issues.length, 0);
});

test('skips stub pages', () => {
  const content = mockContent('TODO: fill in later', {
    frontmatter: { title: 'Stub', pageType: 'stub' },
  });
  const issues = placeholdersRule.check(content, {});
  assertEqual(issues.length, 0);
});

// =============================================================================
// consecutive-bold-labels rule
// =============================================================================

console.log('\n🏷️  consecutive-bold-labels rule');

test('detects consecutive bold labels without blank lines', () => {
  const content = mockContent('**Concern**: Academic publishing too slow\n**Response**: Rigorous evaluation helps');
  const issues = consecutiveBoldLabelsRule.check(content, {});
  assertEqual(issues.length, 1);
  assert(issues[0].message.includes('Consecutive bold label'));
});

test('allows bold labels with blank lines between', () => {
  const content = mockContent('**Concern**: Academic publishing too slow\n\n**Response**: Rigorous evaluation helps');
  const issues = consecutiveBoldLabelsRule.check(content, {});
  assertEqual(issues.length, 0);
});

test('skips bold labels in code blocks', () => {
  const content = mockContent('```\n**Concern**: text\n**Response**: text\n```');
  const issues = consecutiveBoldLabelsRule.check(content, {});
  assertEqual(issues.length, 0);
});

// =============================================================================
// temporal-artifacts rule
// =============================================================================

console.log('\n🕐 temporal-artifacts rule');

test('detects "as of the research" phrasing', () => {
  const content = mockContent('As of the research data through late 2024, this remains true.');
  const issues = temporalArtifactsRule.check(content, {});
  assert(issues.length >= 1);
  assert(issues[0].message.includes('Temporal artifact'));
});

test('detects "no information found in sources" pattern', () => {
  const content = mockContent('No information is available in the available sources.');
  const issues = temporalArtifactsRule.check(content, {});
  assert(issues.length >= 1);
});

test('does not flag normal date references', () => {
  const content = mockContent('OpenAI was founded in 2015.');
  const issues = temporalArtifactsRule.check(content, {});
  assertEqual(issues.length, 0);
});

// =============================================================================
// vague-citations rule
// =============================================================================

console.log('\n📋 vague-citations rule');

test('detects vague citations in table source columns', () => {
  const content = mockContent(
    '| Claim | Date | Source |\n|---|---|---|\n| Some claim | 2024 | Interview |'
  );
  const issues = vagueCitationsRule.check(content, {});
  assert(issues.length >= 1);
  assert(issues[0].message.includes('Vague citation'));
});

test('does not flag specific sources in tables', () => {
  const content = mockContent(
    '| Claim | Date | Source |\n|---|---|---|\n| Some claim | 2024 | Joe Rogan Experience #123 |'
  );
  const issues = vagueCitationsRule.check(content, {});
  assertEqual(issues.length, 0);
});

test('only flags source columns, not other columns', () => {
  const content = mockContent(
    '| Name | Type | Source |\n|---|---|---|\n| Interview Guide | Document | [Link](https://example.com) |'
  );
  // "Interview Guide" is in the Name column, not Source - should not be flagged as vague
  const vagueIssues = content.body ? vagueCitationsRule.check(content, {}) : [];
  // Filter to only vague-citations issues (not other rules)
  const vagueCitationIssues = vagueIssues.filter((i: any) => i.rule === 'vague-citations');
  assertEqual(vagueCitationIssues.length, 0);
});

// =============================================================================
// matchLinesOutsideCode utility
// =============================================================================

console.log('\n🔧 matchLinesOutsideCode utility');

import { matchLinesOutsideCode } from '../mdx-utils.mjs';

test('matches patterns on regular lines', () => {
  const matches: Array<{ text: string; line: number }> = [];
  matchLinesOutsideCode('hello world\nfoo bar', /foo/g, ({ match, lineNum }: { match: RegExpMatchArray; lineNum: number }) => {
    matches.push({ text: match[0], line: lineNum });
  });
  assertEqual(matches.length, 1);
  assertEqual(matches[0].text, 'foo');
  assertEqual(matches[0].line, 2);
});

test('skips matches inside code blocks', () => {
  const matches: string[] = [];
  matchLinesOutsideCode('```\nfoo\n```\nfoo', /foo/g, ({ match }: { match: RegExpMatchArray }) => {
    matches.push(match[0]);
  });
  assertEqual(matches.length, 1);
});

test('supports custom skip function', () => {
  const matches: string[] = [];
  matchLinesOutsideCode('foo bar foo', /foo/g, ({ match }: { match: RegExpMatchArray }) => {
    matches.push(match[0]);
  }, { skip: (body: string, pos: number) => pos > 5 });
  assertEqual(matches.length, 1);
});

test('handles multiple matches per line', () => {
  const matches: string[] = [];
  matchLinesOutsideCode('$1 and $2 and $3', /\$(\d)/g, ({ match }: { match: RegExpMatchArray }) => {
    matches.push(match[0]);
  });
  assertEqual(matches.length, 3);
});

// =============================================================================
// shouldSkipValidation utility
// =============================================================================

console.log('\n🔧 shouldSkipValidation utility');

import { shouldSkipValidation } from '../mdx-utils.mjs';

test('skips stub pages', () => {
  assert(shouldSkipValidation({ pageType: 'stub' }));
});

test('skips documentation pages', () => {
  assert(shouldSkipValidation({ pageType: 'documentation' }));
});

test('does not skip content pages', () => {
  assert(!shouldSkipValidation({ pageType: 'content' }));
});

test('does not skip pages without pageType', () => {
  assert(!shouldSkipValidation({}));
});

// =============================================================================
// Summary
// =============================================================================

console.log('\n──────────────────────────────────────────────────\n');

if (failed > 0) {
  console.log(`❌ Passed: ${passed}, Failed: ${failed}`);
  process.exit(1);
} else {
  console.log(`✅ Passed: ${passed}`);
  console.log('\n🎉 All tests passed!');
}
