/**
 * Unit Tests for Validation Rules
 */

import { describe, it, expect } from 'vitest';
import { Issue, Severity, FixType, createRule } from '../validation-engine.ts';
import { dollarSignsRule } from './dollar-signs.ts';
import { comparisonOperatorsRule } from './comparison-operators.ts';
import { tildeDollarRule } from './tilde-dollar.ts';
import { fakeUrlsRule } from './fake-urls.ts';
import { placeholdersRule } from './placeholders.ts';
import { consecutiveBoldLabelsRule } from './consecutive-bold-labels.ts';
import { temporalArtifactsRule } from './temporal-artifacts.ts';
import { vagueCitationsRule } from './vague-citations.ts';
import { componentPropsRule } from './component-props.ts';
import { citationUrlsRule } from './citation-urls.ts';
import { componentImportsRule } from './component-imports.ts';
import { frontmatterSchemaRule } from './frontmatter-schema.ts';
import { footnoteCoverageRule } from './footnote-coverage.ts';
import { noQuotedSubcategoryRule } from './no-quoted-subcategory.ts';
import { kbSubcategoryCoverageRule } from './kb-subcategory-coverage.ts';
import { preferEntityLinkRule } from './prefer-entitylink.ts';
import { matchLinesOutsideCode } from '../mdx-utils.ts';
import { shouldSkipValidation } from '../mdx-utils.ts';

/**
 * Create a mock content file for testing rules
 */
function mockContent(body: string, opts: Record<string, unknown> = {}): Record<string, unknown> {
  const frontmatter = opts.frontmatter || { title: 'Test Page' };
  const raw = opts.raw || `---\ntitle: Test Page\n---\n${body}`;
  return {
    path: opts.path || 'content/docs/test-page.mdx',
    relativePath: opts.relativePath || 'test-page.mdx',
    body,
    raw,
    frontmatter,
    isIndex: opts.isIndex || false,
  };
}

describe('dollar-signs rule', () => {
  it('detects unescaped $ before numbers', () => {
    const content = mockContent('The cost is $100 per unit.');
    const issues = dollarSignsRule.check(content, {});
    expect(issues.length).toBe(1);
    expect(issues[0].message.includes('Unescaped dollar sign')).toBe(true);
    expect(issues[0].severity).toBe(Severity.ERROR);
  });

  it('allows escaped \\$ before numbers', () => {
    const content = mockContent('The cost is \\$100 per unit.');
    const issues = dollarSignsRule.check(content, {});
    expect(issues.length).toBe(0);
  });

  it('detects double-escaped \\\\$ in body', () => {
    const content = mockContent('The cost is \\\\$100.');
    const issues = dollarSignsRule.check(content, {});
    // Should detect double-escaped (the regex is /\\\\\$/g which matches literal \\$)
    expect(issues.some((i: any) => i.message.includes('Double-escaped'))).toBe(true);
  });

  it('skips $ in code blocks', () => {
    const content = mockContent('```\n$100\n```');
    const issues = dollarSignsRule.check(content, {});
    expect(issues.length).toBe(0);
  });

  it('detects multiple $ on same line', () => {
    const content = mockContent('Between $5 and $10.');
    const issues = dollarSignsRule.check(content, {});
    expect(issues.length).toBe(2);
  });
});

describe('comparison-operators rule', () => {
  it('detects unescaped < before numbers', () => {
    const content = mockContent('Response time <10ms is ideal.');
    const issues = comparisonOperatorsRule.check(content, {});
    expect(issues.length).toBe(1);
    expect(issues[0].message.includes('Unescaped')).toBe(true);
    expect(issues[0].severity).toBe(Severity.ERROR);
  });

  it('allows already-escaped &lt;', () => {
    const content = mockContent('Response time &lt;10ms is ideal.');
    const issues = comparisonOperatorsRule.check(content, {});
    expect(issues.length).toBe(0);
  });

  it('skips < in code blocks', () => {
    const content = mockContent('```\nif (x < 10) {}\n```');
    const issues = comparisonOperatorsRule.check(content, {});
    expect(issues.length).toBe(0);
  });

  it('does not flag valid HTML/JSX tags', () => {
    const content = mockContent('<div>hello</div>');
    const issues = comparisonOperatorsRule.check(content, {});
    expect(issues.length).toBe(0);
  });
});

describe('tilde-dollar rule', () => {
  it('detects ~\\$ pattern', () => {
    const content = mockContent('approximately ~\\$29M in funding.');
    const issues = tildeDollarRule.check(content, {});
    expect(issues.length >= 1).toBe(true);
    expect(issues[0].message.includes('Tilde before escaped dollar')).toBe(true);
    expect(issues[0].severity).toBe(Severity.ERROR);
  });

  it('allows ≈\\$ pattern', () => {
    const content = mockContent('approximately ≈\\$29M in funding.');
    const issues = tildeDollarRule.check(content, {});
    // Should not flag the ≈ version
    const tildeDollarIssues = issues.filter((i: any) => i.message.includes('Tilde before escaped'));
    expect(tildeDollarIssues.length).toBe(0);
  });

  it('detects tilde before number in table cell', () => {
    const content = mockContent('| Name | Value |\n|---|---|\n| Test | ~86% |');
    const issues = tildeDollarRule.check(content, {});
    expect(issues.length >= 1).toBe(true);
    expect(issues.some((i: any) => i.message.includes('Tilde in table cell'))).toBe(true);
  });

  it('detects \\≈ escaped approximation symbol', () => {
    const content = mockContent('raises \\≈\\$5M in funding.');
    const issues = tildeDollarRule.check(content, {});
    expect(issues.length >= 1).toBe(true);
    expect(issues.some((i: any) => i.message.includes('Escaped approximation symbol'))).toBe(true);
    expect(issues.find((i: any) => i.message.includes('Escaped approximation symbol'))?.severity).toBe(Severity.ERROR);
  });

  it('allows unescaped ≈ symbol', () => {
    const content = mockContent('raises ≈\\$5M in funding.');
    const issues = tildeDollarRule.check(content, {});
    const escapedApproxIssues = issues.filter((i: any) => i.message.includes('Escaped approximation symbol'));
    expect(escapedApproxIssues.length).toBe(0);
  });
});

describe('fake-urls rule', () => {
  it('detects example.com URLs', () => {
    const content = mockContent('[link](https://example.com/page)');
    const issues = fakeUrlsRule.check(content, {});
    expect(issues.length >= 1).toBe(true);
    expect(issues[0].message.includes('example.com')).toBe(true);
  });

  it('detects localhost URLs', () => {
    const content = mockContent('[local](http://localhost:3000/test)');
    const issues = fakeUrlsRule.check(content, {});
    expect(issues.length >= 1).toBe(true);
    expect(issues[0].message.includes('localhost')).toBe(true);
  });

  it('detects placeholder domains', () => {
    const content = mockContent('[test](https://placeholder.com/stuff)');
    const issues = fakeUrlsRule.check(content, {});
    expect(issues.length >= 1).toBe(true);
  });

  it('does not flag real URLs', () => {
    const content = mockContent('[real](https://arxiv.org/abs/2301.01234)');
    const issues = fakeUrlsRule.check(content, {});
    expect(issues.length).toBe(0);
  });

  it('skips documentation pages', () => {
    const content = mockContent('[link](https://example.com)', {
      frontmatter: { title: 'Docs', pageType: 'documentation' },
    });
    const issues = fakeUrlsRule.check(content, {});
    expect(issues.length).toBe(0);
  });

  it('skips stub pages', () => {
    const content = mockContent('[link](https://example.com)', {
      frontmatter: { title: 'Stub', pageType: 'stub' },
    });
    const issues = fakeUrlsRule.check(content, {});
    expect(issues.length).toBe(0);
  });

  it('skips internal docs', () => {
    const content = mockContent('[link](https://example.com)', {
      relativePath: '/internal/guide.mdx',
    });
    const issues = fakeUrlsRule.check(content, {});
    expect(issues.length).toBe(0);
  });
});

describe('placeholders rule', () => {
  it('detects TODO markers', () => {
    const content = mockContent('This section needs TODO: fill in details.');
    const issues = placeholdersRule.check(content, {});
    expect(issues.length >= 1).toBe(true);
    expect(issues.some((i: any) => i.message.includes('TODO'))).toBe(true);
  });

  it('detects Lorem ipsum', () => {
    const content = mockContent('Lorem ipsum dolor sit amet.');
    const issues = placeholdersRule.check(content, {});
    expect(issues.length >= 1).toBe(true);
    expect(issues[0].severity).toBe(Severity.ERROR);
  });

  it('detects bracketed placeholders', () => {
    const content = mockContent('The value is [TBD] and [Value] here.');
    const issues = placeholdersRule.check(content, {});
    expect(issues.length >= 1).toBe(true);
  });

  it('skips placeholders in code blocks', () => {
    const content = mockContent('```\nTODO: implement this\n```');
    const issues = placeholdersRule.check(content, {});
    expect(issues.length).toBe(0);
  });

  it('skips stub pages', () => {
    const content = mockContent('TODO: fill in later', {
      frontmatter: { title: 'Stub', pageType: 'stub' },
    });
    const issues = placeholdersRule.check(content, {});
    expect(issues.length).toBe(0);
  });
});

describe('consecutive-bold-labels rule', () => {
  it('detects consecutive bold labels without blank lines', () => {
    const content = mockContent('**Concern**: Academic publishing too slow\n**Response**: Rigorous evaluation helps');
    const issues = consecutiveBoldLabelsRule.check(content, {});
    expect(issues.length).toBe(1);
    expect(issues[0].message.includes('Consecutive bold label')).toBe(true);
  });

  it('allows bold labels with blank lines between', () => {
    const content = mockContent('**Concern**: Academic publishing too slow\n\n**Response**: Rigorous evaluation helps');
    const issues = consecutiveBoldLabelsRule.check(content, {});
    expect(issues.length).toBe(0);
  });

  it('skips bold labels in code blocks', () => {
    const content = mockContent('```\n**Concern**: text\n**Response**: text\n```');
    const issues = consecutiveBoldLabelsRule.check(content, {});
    expect(issues.length).toBe(0);
  });
});

describe('temporal-artifacts rule', () => {
  it('detects "as of the research" phrasing', () => {
    const content = mockContent('As of the research data through late 2024, this remains true.');
    const issues = temporalArtifactsRule.check(content, {});
    expect(issues.length >= 1).toBe(true);
    expect(issues[0].message.includes('Temporal artifact')).toBe(true);
  });

  it('detects "no information found in sources" pattern', () => {
    const content = mockContent('No information is available in the available sources.');
    const issues = temporalArtifactsRule.check(content, {});
    expect(issues.length >= 1).toBe(true);
  });

  it('does not flag normal date references', () => {
    const content = mockContent('OpenAI was founded in 2015.');
    const issues = temporalArtifactsRule.check(content, {});
    expect(issues.length).toBe(0);
  });
});

describe('vague-citations rule', () => {
  it('detects vague citations in table source columns', () => {
    const content = mockContent(
      '| Claim | Date | Source |\n|---|---|---|\n| Some claim | 2024 | Interview |'
    );
    const issues = vagueCitationsRule.check(content, {});
    expect(issues.length >= 1).toBe(true);
    expect(issues[0].message.includes('Vague citation')).toBe(true);
  });

  it('does not flag specific sources in tables', () => {
    const content = mockContent(
      '| Claim | Date | Source |\n|---|---|---|\n| Some claim | 2024 | Joe Rogan Experience #123 |'
    );
    const issues = vagueCitationsRule.check(content, {});
    expect(issues.length).toBe(0);
  });

  it('only flags source columns, not other columns', () => {
    const content = mockContent(
      '| Name | Type | Source |\n|---|---|---|\n| Interview Guide | Document | [Link](https://example.com) |'
    );
    // "Interview Guide" is in the Name column, not Source - should not be flagged as vague
    const vagueIssues = content.body ? vagueCitationsRule.check(content, {}) : [];
    // Filter to only vague-citations issues (not other rules)
    const vagueCitationIssues = vagueIssues.filter((i: any) => i.rule === 'vague-citations');
    expect(vagueCitationIssues.length).toBe(0);
  });
});

describe('matchLinesOutsideCode utility', () => {
  it('matches patterns on regular lines', () => {
    const matches: Array<{ text: string; line: number }> = [];
    matchLinesOutsideCode('hello world\nfoo bar', /foo/g, ({ match, lineNum }: { match: RegExpMatchArray; lineNum: number }) => {
      matches.push({ text: match[0], line: lineNum });
    });
    expect(matches.length).toBe(1);
    expect(matches[0].text).toBe('foo');
    expect(matches[0].line).toBe(2);
  });

  it('skips matches inside code blocks', () => {
    const matches: string[] = [];
    matchLinesOutsideCode('```\nfoo\n```\nfoo', /foo/g, ({ match }: { match: RegExpMatchArray }) => {
      matches.push(match[0]);
    });
    expect(matches.length).toBe(1);
  });

  it('supports custom skip function', () => {
    const matches: string[] = [];
    matchLinesOutsideCode('foo bar foo', /foo/g, ({ match }: { match: RegExpMatchArray }) => {
      matches.push(match[0]);
    }, { skip: (body: string, pos: number) => pos > 5 });
    expect(matches.length).toBe(1);
  });

  it('handles multiple matches per line', () => {
    const matches: string[] = [];
    matchLinesOutsideCode('$1 and $2 and $3', /\$(\d)/g, ({ match }: { match: RegExpMatchArray }) => {
      matches.push(match[0]);
    });
    expect(matches.length).toBe(3);
  });
});

describe('shouldSkipValidation utility', () => {
  it('skips stub pages', () => {
    expect(shouldSkipValidation({ pageType: 'stub' })).toBe(true);
  });

  it('skips documentation pages', () => {
    expect(shouldSkipValidation({ pageType: 'documentation' })).toBe(true);
  });

  it('does not skip content pages', () => {
    expect(shouldSkipValidation({ pageType: 'content' })).toBe(false);
  });

  it('does not skip pages without pageType', () => {
    expect(shouldSkipValidation({})).toBe(false);
  });

  it('skips internal entity type pages', () => {
    expect(shouldSkipValidation({ entityType: 'internal' })).toBe(true);
  });

  it('does not skip non-internal entity types', () => {
    expect(shouldSkipValidation({ entityType: 'risk' })).toBe(false);
  });
});

// =============================================================================
// component-props rule
// =============================================================================

describe('component-props rule', () => {
  it('detects KeyPeople with children content', () => {
    const content = mockContent('<KeyPeople>\n- Person A\n- Person B\n</KeyPeople>');
    const issues = componentPropsRule.check(content, {});
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('KeyPeople');
    expect(issues[0].message).toContain('people');
    expect(issues[0].severity).toBe(Severity.ERROR);
  });

  it('allows KeyPeople with people prop', () => {
    const content = mockContent('<KeyPeople people={[{ name: "Alice", role: "CEO" }]} />');
    const issues = componentPropsRule.check(content, {});
    expect(issues.length).toBe(0);
  });

  it('detects KeyQuestions with children content', () => {
    const content = mockContent('<KeyQuestions>\n- Question 1?\n</KeyQuestions>');
    const issues = componentPropsRule.check(content, {});
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('KeyQuestions');
    expect(issues[0].message).toContain('questions');
  });

  it('allows KeyQuestions with questions prop', () => {
    const content = mockContent('<KeyQuestions questions={["Q1?", "Q2?"]} />');
    const issues = componentPropsRule.check(content, {});
    expect(issues.length).toBe(0);
  });

  it('returns no issues for content without prop-required components', () => {
    const content = mockContent('Just some regular content here.');
    const issues = componentPropsRule.check(content, {});
    expect(issues.length).toBe(0);
  });
});

// =============================================================================
// citation-urls rule
// =============================================================================

describe('citation-urls rule', () => {
  it('detects undefined URLs in footnotes', () => {
    const content = mockContent('[^1]: [Some Paper](undefined)');
    const issues = citationUrlsRule.check(content, {});
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('undefined');
    expect(issues[0].severity).toBe(Severity.ERROR);
  });

  it('detects empty URLs in footnotes', () => {
    const content = mockContent('[^2]: [Some Paper]()');
    const issues = citationUrlsRule.check(content, {});
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('empty');
    expect(issues[0].severity).toBe(Severity.ERROR);
  });

  it('detects placeholder URLs in footnotes', () => {
    const content = mockContent('[^3]: [Title](https://example.com)');
    const issues = citationUrlsRule.check(content, {});
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('placeholder');
    expect(issues[0].severity).toBe(Severity.WARNING);
  });

  it('allows valid footnote URLs', () => {
    const content = mockContent('[^1]: [Real Paper](https://arxiv.org/abs/2301.01234)');
    const issues = citationUrlsRule.check(content, {});
    expect(issues.length).toBe(0);
  });

  it('detects multiple bad footnotes', () => {
    const content = mockContent('[^1]: [A](undefined)\n[^2]: [B]()');
    const issues = citationUrlsRule.check(content, {});
    expect(issues.length).toBe(2);
  });

  it('returns no issues for content without footnotes', () => {
    const content = mockContent('Regular content with [a link](https://real.com).');
    const issues = citationUrlsRule.check(content, {});
    expect(issues.length).toBe(0);
  });
});

// =============================================================================
// component-imports rule
// =============================================================================

describe('component-imports rule', () => {
  it('detects missing imports for used wiki components', () => {
    const raw = `---\ntitle: Test\n---\n<EntityLink id="test">Test</EntityLink>`;
    const content = mockContent('<EntityLink id="test">Test</EntityLink>', { raw });
    const issues = componentImportsRule.check(content, {});
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('EntityLink');
    expect(issues[0].severity).toBe(Severity.ERROR);
  });

  it('allows properly imported components', () => {
    const raw = `---\ntitle: Test\n---\nimport { EntityLink } from '@components/wiki';\n\n<EntityLink id="test">Test</EntityLink>`;
    const content = mockContent('<EntityLink id="test">Test</EntityLink>', { raw });
    const issues = componentImportsRule.check(content, {});
    expect(issues.length).toBe(0);
  });

  it('skips unknown (non-wiki) components', () => {
    const raw = `---\ntitle: Test\n---\n<CustomComponent />`;
    const content = mockContent('<CustomComponent />', { raw });
    const issues = componentImportsRule.check(content, {});
    expect(issues.length).toBe(0);
  });

  it('skips components in code blocks', () => {
    const body = '```\n<EntityLink id="test">Test</EntityLink>\n```';
    const raw = `---\ntitle: Test\n---\n${body}`;
    const content = mockContent(body, { raw });
    const issues = componentImportsRule.check(content, {});
    expect(issues.length).toBe(0);
  });

  it('detects multiple missing imports', () => {
    const body = '<EntityLink id="test">Test</EntityLink>\n<Mermaid chart={`graph TD`} />';
    const raw = `---\ntitle: Test\n---\n${body}`;
    const content = mockContent(body, { raw });
    const issues = componentImportsRule.check(content, {});
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('EntityLink');
    expect(issues[0].message).toContain('Mermaid');
  });

  it('returns no issues for content without components', () => {
    const content = mockContent('Just text, no components.');
    const issues = componentImportsRule.check(content, {});
    expect(issues.length).toBe(0);
  });
});

// =============================================================================
// frontmatter-schema rule
// =============================================================================

describe('frontmatter-schema rule', () => {
  it('valid frontmatter passes', () => {
    const raw = '---\ntitle: Good Page\ndescription: A valid page\nquality: 50\n---\nContent';
    const content = mockContent('Content', {
      raw,
      frontmatter: { title: 'Good Page', description: 'A valid page', quality: 50 },
    });
    const issues = frontmatterSchemaRule.check(content, {});
    expect(issues.length).toBe(0);
  });

  it('detects invalid quality value (out of range)', () => {
    const raw = '---\ntitle: Test\nquality: 200\n---\nContent';
    const content = mockContent('Content', {
      raw,
      frontmatter: { title: 'Test', quality: 200 },
    });
    const issues = frontmatterSchemaRule.check(content, {});
    expect(issues.some((i: any) => i.message.includes('quality'))).toBe(true);
  });

  it('detects missing title', () => {
    const raw = '---\ndescription: No title\n---\nContent';
    const content = mockContent('Content', {
      raw,
      frontmatter: { description: 'No title' },
    });
    const issues = frontmatterSchemaRule.check(content, {});
    expect(issues.some((i: any) => i.message.includes('title'))).toBe(true);
  });

  it('detects update_frequency without lastEdited', () => {
    const raw = '---\ntitle: Test\nupdate_frequency: 7\n---\nContent';
    const content = mockContent('Content', {
      raw,
      frontmatter: { title: 'Test', update_frequency: 7 },
    });
    const issues = frontmatterSchemaRule.check(content, {});
    expect(issues.some((i: any) => i.message.includes('update_frequency'))).toBe(true);
  });

  it('allows update_frequency with lastEdited', () => {
    const raw = '---\ntitle: Test\nupdate_frequency: 7\nlastEdited: "2025-01-01"\n---\nContent';
    const content = mockContent('Content', {
      raw,
      frontmatter: { title: 'Test', update_frequency: 7, lastEdited: '2025-01-01' },
    });
    const issues = frontmatterSchemaRule.check(content, {});
    const crossFieldIssues = issues.filter((i: any) => i.message.includes('update_frequency'));
    expect(crossFieldIssues.length).toBe(0);
  });

  it('detects evergreen: false with update_frequency (contradiction)', () => {
    const raw = '---\ntitle: Test\nevergreen: false\nupdate_frequency: 7\nlastEdited: "2025-01-01"\n---\nContent';
    const content = mockContent('Content', {
      raw,
      frontmatter: { title: 'Test', evergreen: false, update_frequency: 7, lastEdited: '2025-01-01' },
    });
    const issues = frontmatterSchemaRule.check(content, {});
    expect(issues.some((i: any) => i.message.includes('evergreen: false') && i.message.includes('update_frequency'))).toBe(true);
    expect(issues.some((i: any) => i.severity === Severity.ERROR && i.message.includes('evergreen'))).toBe(true);
  });

  it('allows evergreen: false without update_frequency', () => {
    const raw = '---\ntitle: Test Report\nevergreen: false\nlastEdited: "2025-01-01"\n---\nContent';
    const content = mockContent('Content', {
      raw,
      frontmatter: { title: 'Test Report', evergreen: false, lastEdited: '2025-01-01' },
    });
    const issues = frontmatterSchemaRule.check(content, {});
    const evergreenIssues = issues.filter((i: any) => i.message.includes('evergreen'));
    expect(evergreenIssues.length).toBe(0);
  });

  it('allows evergreen: true with update_frequency', () => {
    const raw = '---\ntitle: Test\nevergreen: true\nupdate_frequency: 7\nlastEdited: "2025-01-01"\n---\nContent';
    const content = mockContent('Content', {
      raw,
      frontmatter: { title: 'Test', evergreen: true, update_frequency: 7, lastEdited: '2025-01-01' },
    });
    const issues = frontmatterSchemaRule.check(content, {});
    const evergreenIssues = issues.filter((i: any) => i.message.includes('evergreen'));
    expect(evergreenIssues.length).toBe(0);
  });

  it('does not warn about missing update_frequency for graded format when evergreen: false', () => {
    const raw = '---\ntitle: Test\ncontentFormat: table\nevergreen: false\nlastEdited: "2025-01-01"\n---\nContent';
    const content = mockContent('Content', {
      raw,
      frontmatter: { title: 'Test', contentFormat: 'table', evergreen: false, lastEdited: '2025-01-01' },
    });
    const issues = frontmatterSchemaRule.check(content, {});
    const updateFreqIssues = issues.filter((i: any) => i.message.includes('update_frequency'));
    expect(updateFreqIssues.length).toBe(0);
  });

  it('detects invalid pageType', () => {
    const raw = '---\ntitle: Test\npageType: invalid\n---\nContent';
    const content = mockContent('Content', {
      raw,
      frontmatter: { title: 'Test', pageType: 'invalid' },
    });
    const issues = frontmatterSchemaRule.check(content, {});
    expect(issues.some((i: any) => i.message.includes('pageType'))).toBe(true);
  });
});

// =============================================================================
// footnote-coverage rule
// =============================================================================

describe('footnote-coverage rule', () => {
  const longProse = 'This is a sentence with several words in it. '.repeat(20); // ~200 words
  const veryLongProse = longProse + longProse; // ~400 words

  it('warns when a knowledge-base page has no footnotes and sufficient prose', () => {
    const content = mockContent(veryLongProse, {
      relativePath: 'knowledge-base/responses/test-page.mdx',
    });
    const issues = footnoteCoverageRule.check(content, {});
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('No footnote citations');
    expect(issues[0].severity).toBe(Severity.WARNING);
  });

  it('does not warn when page has footnote citations', () => {
    const content = mockContent(veryLongProse + '\n\nSome claim.[^1]\n\n[^1]: [Source](https://example.org)', {
      relativePath: 'knowledge-base/organizations/test-org.mdx',
    });
    const issues = footnoteCoverageRule.check(content, {});
    expect(issues.length).toBe(0);
  });

  it('skips non-knowledge-base pages', () => {
    const content = mockContent(veryLongProse, {
      relativePath: 'guides/some-guide.mdx',
    });
    const issues = footnoteCoverageRule.check(content, {});
    expect(issues.length).toBe(0);
  });

  it('skips short pages', () => {
    const content = mockContent('A short page with few words.', {
      relativePath: 'knowledge-base/risks/short-risk.mdx',
    });
    const issues = footnoteCoverageRule.check(content, {});
    expect(issues.length).toBe(0);
  });

  it('skips index pages', () => {
    const content = mockContent(veryLongProse, {
      relativePath: 'knowledge-base/index.mdx',
      isIndex: true,
    });
    const issues = footnoteCoverageRule.check(content, {});
    expect(issues.length).toBe(0);
  });

  it('skips stub pages', () => {
    const content = mockContent(veryLongProse, {
      relativePath: 'knowledge-base/risks/test-stub.mdx',
      frontmatter: { title: 'Test', pageType: 'stub' },
    });
    const issues = footnoteCoverageRule.check(content, {});
    expect(issues.length).toBe(0);
  });

  it('does not count footnote definitions as references', () => {
    // A page with only footnote definitions but no inline references
    const content = mockContent(veryLongProse + '\n\n[^1]: [Source](https://example.org)', {
      relativePath: 'knowledge-base/people/test-person.mdx',
    });
    const issues = footnoteCoverageRule.check(content, {});
    expect(issues.length).toBe(1); // definitions alone don't count
  });
});

// =============================================================================
// no-quoted-subcategory rule
// =============================================================================

describe('no-quoted-subcategory rule', () => {
  it('detects double-quoted subcategory values', () => {
    const raw = '---\ntitle: Test\nsubcategory: "labs"\n---\nContent';
    const content = mockContent('Content', {
      raw,
      frontmatter: { title: 'Test', subcategory: 'labs' },
    });
    const issues = noQuotedSubcategoryRule.check(content, {});
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('labs');
    expect(issues[0].message).toContain('subcategory: labs');
    expect(issues[0].severity).toBe(Severity.ERROR);
  });

  it('detects single-quoted subcategory values', () => {
    const raw = "---\ntitle: Test\nsubcategory: 'alignment'\n---\nContent";
    const content = mockContent('Content', {
      raw,
      frontmatter: { title: 'Test', subcategory: 'alignment' },
    });
    const issues = noQuotedSubcategoryRule.check(content, {});
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain("subcategory: 'alignment'");
    expect(issues[0].severity).toBe(Severity.ERROR);
  });

  it('allows unquoted subcategory values', () => {
    const raw = '---\ntitle: Test\nsubcategory: labs\n---\nContent';
    const content = mockContent('Content', {
      raw,
      frontmatter: { title: 'Test', subcategory: 'labs' },
    });
    const issues = noQuotedSubcategoryRule.check(content, {});
    expect(issues.length).toBe(0);
  });

  it('allows pages without a subcategory field', () => {
    const raw = '---\ntitle: Test\n---\nContent';
    const content = mockContent('Content', {
      raw,
      frontmatter: { title: 'Test' },
    });
    const issues = noQuotedSubcategoryRule.check(content, {});
    expect(issues.length).toBe(0);
  });

  it('does not flag subcategory-like text in the page body', () => {
    // Proper frontmatter (no subcategory field) + body text that looks like subcategory.
    // The closing --- ensures frontmatter extraction actually runs and excludes the body.
    const raw = '---\ntitle: Test\n---\n\nHere subcategory: "labs" appears in body text';
    const content = mockContent('subcategory: "labs" appears in body text', {
      raw,
      frontmatter: { title: 'Test' },
    });
    const issues = noQuotedSubcategoryRule.check(content, {});
    expect(issues.length).toBe(0);
  });

  it('detects hyphenated quoted subcategory values', () => {
    const raw = '---\ntitle: Test\nsubcategory: "factors-ai-capabilities"\n---\nContent';
    const content = mockContent('Content', {
      raw,
      frontmatter: { title: 'Test', subcategory: 'factors-ai-capabilities' },
    });
    const issues = noQuotedSubcategoryRule.check(content, {});
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('factors-ai-capabilities');
  });

  it('reports correct line number for the quoted subcategory', () => {
    const raw = '---\ntitle: Test\ndescription: A test page\nsubcategory: "labs"\n---\nContent';
    const content = mockContent('Content', {
      raw,
      frontmatter: { title: 'Test', description: 'A test page', subcategory: 'labs' },
    });
    const issues = noQuotedSubcategoryRule.check(content, {});
    expect(issues.length).toBe(1);
    // subcategory is on line 4 in this file (after ---, title, description)
    expect(issues[0].line).toBe(4);
  });

  it('reports correct line number even when the matched text appears earlier in the file', () => {
    // Edge case: description field contains text identical to the subcategory line.
    // With raw.indexOf() this would return the wrong (earlier) line; with quotedMatch.index it's correct.
    const raw = '---\ntitle: Test\ndescription: subcategory: "labs"\nsubcategory: "labs"\n---\nContent';
    const content = mockContent('Content', {
      raw,
      frontmatter: { title: 'Test', description: 'subcategory: "labs"', subcategory: 'labs' },
    });
    const issues = noQuotedSubcategoryRule.check(content, {});
    expect(issues.length).toBe(1);
    // subcategory is on line 4, NOT line 3 (where description contains identical text)
    expect(issues[0].line).toBe(4);
  });
});

// =============================================================================
// kb-subcategory-coverage rule
// =============================================================================

describe('kb-subcategory-coverage rule', () => {
  /** Build a minimal mock KB page */
  function kbPage(
    section: string,
    slug: string,
    opts: { subcategory?: string; isIndex?: boolean } = {},
  ): Record<string, unknown> {
    const isIndex = opts.isIndex ?? false;
    const filename = isIndex ? 'index.mdx' : `${slug}.mdx`;
    const relativePath = `knowledge-base/${section}/${filename}`;
    return {
      path: `/content/docs/${relativePath}`,
      relativePath,
      body: 'Body text.',
      raw: `---\ntitle: ${slug}\n---\nBody text.`,
      frontmatter: {
        title: slug,
        ...(opts.subcategory ? { subcategory: opts.subcategory } : {}),
      },
      isIndex,
    };
  }

  it('emits no issues when all non-index pages have a subcategory', () => {
    const files = [
      kbPage('risks', 'index', { isIndex: true }),
      kbPage('risks', 'bio-risk', { subcategory: 'misuse' }),
      kbPage('risks', 'ai-takeover', { subcategory: 'accident' }),
      kbPage('risks', 'compute-concentration', { subcategory: 'structural' }),
    ];
    const issues = kbSubcategoryCoverageRule.check(files as any, {} as any);
    expect(issues.length).toBe(0);
  });

  it('emits no issues when missing ratio is exactly at the threshold (20%)', () => {
    // 1 missing out of 5 = 20%, not > 20%
    const files = [
      kbPage('capabilities', 'index', { isIndex: true }),
      kbPage('capabilities', 'page-a', { subcategory: 'core' }),
      kbPage('capabilities', 'page-b', { subcategory: 'core' }),
      kbPage('capabilities', 'page-c', { subcategory: 'core' }),
      kbPage('capabilities', 'page-d', { subcategory: 'core' }),
      kbPage('capabilities', 'page-e'), // missing — 1/5 = 20%
    ];
    const issues = kbSubcategoryCoverageRule.check(files as any, {} as any);
    expect(issues.length).toBe(0);
  });

  it('warns when >20% of non-index pages lack subcategory', () => {
    // 3 missing out of 5 = 60% — well above threshold
    const files = [
      kbPage('people', 'index', { isIndex: true }),
      kbPage('people', 'alice', { subcategory: 'researchers' }),
      kbPage('people', 'bob', { subcategory: 'researchers' }),
      kbPage('people', 'carol'), // missing
      kbPage('people', 'dave'), // missing
      kbPage('people', 'eve'), // missing
    ];
    const issues = kbSubcategoryCoverageRule.check(files as any, {} as any);
    expect(issues.length).toBe(1);
    expect(issues[0].rule).toBe('kb-subcategory-coverage');
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('"people"');
    expect(issues[0].message).toContain('3/5');
  });

  it('lists the filenames of pages missing subcategory in the warning message', () => {
    const files = [
      kbPage('debates', 'index', { isIndex: true }),
      kbPage('debates', 'page-x', { subcategory: 'alignment' }),
      kbPage('debates', 'page-y'), // missing
      kbPage('debates', 'page-z'), // missing
      kbPage('debates', 'page-w'), // missing — 3/4 = 75%
    ];
    const issues = kbSubcategoryCoverageRule.check(files as any, {} as any);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('page-y.mdx');
    expect(issues[0].message).toContain('page-z.mdx');
    expect(issues[0].message).toContain('page-w.mdx');
  });

  it('reports on the section index page when one exists', () => {
    const indexFile = kbPage('history', 'index', { isIndex: true });
    const files = [
      indexFile,
      kbPage('history', 'hist-a'), // missing
      kbPage('history', 'hist-b'), // missing
      kbPage('history', 'hist-c'), // missing — 3/3 = 100%
    ];
    const issues = kbSubcategoryCoverageRule.check(files as any, {} as any);
    expect(issues.length).toBe(1);
    expect(issues[0].file).toBe(indexFile.path);
  });

  it('does not count the index page itself as missing subcategory', () => {
    // If the index page has no subcategory (normal — indices don't need one),
    // it should not inflate the missing count.
    const files = [
      kbPage('incidents', 'index', { isIndex: true }), // no subcategory on index
      kbPage('incidents', 'page-a', { subcategory: 'natural' }),
      kbPage('incidents', 'page-b', { subcategory: 'natural' }),
    ];
    const issues = kbSubcategoryCoverageRule.check(files as any, {} as any);
    expect(issues.length).toBe(0);
  });

  it('ignores non-knowledge-base pages entirely', () => {
    const files = [
      {
        path: '/content/docs/internal/guide.mdx',
        relativePath: 'internal/guide.mdx',
        body: 'Body.',
        raw: '---\ntitle: Guide\n---\nBody.',
        frontmatter: { title: 'Guide' },
        isIndex: false,
      },
      {
        path: '/content/docs/guides/intro.mdx',
        relativePath: 'guides/intro.mdx',
        body: 'Body.',
        raw: '---\ntitle: Intro\n---\nBody.',
        frontmatter: { title: 'Intro' },
        isIndex: false,
      },
    ];
    const issues = kbSubcategoryCoverageRule.check(files as any, {} as any);
    expect(issues.length).toBe(0);
  });

  it('skips sections with no non-index pages', () => {
    // A section that only has an index page should not cause a division-by-zero warning
    const files = [
      kbPage('metrics', 'index', { isIndex: true }),
    ];
    const issues = kbSubcategoryCoverageRule.check(files as any, {} as any);
    expect(issues.length).toBe(0);
  });

  it('handles multiple sections independently', () => {
    // "risks" is fine, "debates" is over threshold
    const files = [
      kbPage('risks', 'index', { isIndex: true }),
      kbPage('risks', 'risk-a', { subcategory: 'accident' }),
      kbPage('risks', 'risk-b', { subcategory: 'misuse' }),
      kbPage('debates', 'index', { isIndex: true }),
      kbPage('debates', 'debate-a'), // missing
      kbPage('debates', 'debate-b'), // missing
      kbPage('debates', 'debate-c'), // missing — 3/3 = 100%
    ];
    const issues = kbSubcategoryCoverageRule.check(files as any, {} as any);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('"debates"');
  });
});

// =============================================================================
// prefer-entitylink rule
// =============================================================================

describe('prefer-entitylink rule', () => {
  // Engine mock with known slugs from the real pathRegistry.
  // The rule reads pathRegistry.json from disk and caches the reverse map; tests
  // that check ERROR path rely on URLs present in the real pathRegistry.json.
  const engineWithRegistry = {
    idRegistry: {
      bySlug: {
        // 'community-notes-for-everything' maps to /knowledge-base/responses/community-notes-for-everything/
        // in the real pathRegistry — used to test the ERROR path without mocking disk I/O.
        'community-notes-for-everything': 'E300',
        'miri': 'E100',
        'deceptive-alignment': 'E200',
      },
      byNumericId: {
        'E300': 'community-notes-for-everything',
        'E100': 'miri',
        'E200': 'deceptive-alignment',
      },
    },
  };

  it('emits ERROR with REPLACE_TEXT fix for markdown link to registered entity', () => {
    // 'community-notes-for-everything' is in the real pathRegistry.json at
    // /knowledge-base/responses/community-notes-for-everything/, so the reverse
    // map lookup returns the slug, and idRegistry.bySlug finds it → ERROR.
    const content = mockContent(
      'See [Community Notes](/knowledge-base/responses/community-notes-for-everything/) for more.',
    );
    const issues = preferEntityLinkRule.check(content as any, engineWithRegistry as any);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe(Severity.ERROR);
    expect(issues[0].fix?.type).toBe(FixType.REPLACE_TEXT);
    expect(issues[0].fix?.newText).toBe('<EntityLink id="E300" name="community-notes-for-everything">Community Notes</EntityLink>');
  });

  it('falls back to WARNING when entity slug is not in idRegistry', () => {
    // Same URL but engine has no idRegistry — the entity slug is found in the
    // pathRegistry reverse map but not in idRegistry.bySlug, so falls to WARNING.
    const content = mockContent(
      'See [Community Notes](/knowledge-base/responses/community-notes-for-everything/) for more.',
    );
    const issues = preferEntityLinkRule.check(content as any, { idRegistry: null } as any);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe(Severity.WARNING);
    expect(issues[0].fix).toBeNull();
  });

  it('emits WARNING for internal link to unregistered path', () => {
    const content = mockContent(
      'See [Unknown Page](/knowledge-base/some-unknown-path/) for more.',
    );
    const issues = preferEntityLinkRule.check(content as any, engineWithRegistry as any);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe(Severity.WARNING);
    expect(issues[0].rule).toBe('prefer-entitylink');
  });

  it('emits no issue for external links', () => {
    const content = mockContent(
      'See [External](https://example.com/page) for more.',
    );
    const issues = preferEntityLinkRule.check(content as any, engineWithRegistry as any);
    expect(issues.length).toBe(0);
  });

  it('emits no issue for links already using EntityLink', () => {
    const content = mockContent(
      '<EntityLink id="miri">MIRI</EntityLink> is an organization.',
    );
    const issues = preferEntityLinkRule.check(content as any, engineWithRegistry as any);
    expect(issues.length).toBe(0);
  });

  it('skips links inside code blocks', () => {
    const content = mockContent(
      '```\n[Community Notes](/knowledge-base/responses/community-notes-for-everything/)\n```',
    );
    const issues = preferEntityLinkRule.check(content as any, engineWithRegistry as any);
    expect(issues.length).toBe(0);
  });

  it('skips stub pages', () => {
    const content = mockContent(
      'See [Community Notes](/knowledge-base/responses/community-notes-for-everything/) for more.',
      { frontmatter: { title: 'Test', pageType: 'stub' } },
    );
    const issues = preferEntityLinkRule.check(content as any, engineWithRegistry as any);
    expect(issues.length).toBe(0);
  });

  it('skips internal documentation pages', () => {
    // The rule checks relativePath.includes('/internal/') — needs surrounding slashes
    const content = mockContent(
      'See [Community Notes](/knowledge-base/responses/community-notes-for-everything/) for more.',
      { relativePath: 'docs/internal/some-doc.mdx' },
    );
    const issues = preferEntityLinkRule.check(content as any, engineWithRegistry as any);
    expect(issues.length).toBe(0);
  });

  it('excludes top-level section index paths', () => {
    const content = mockContent(
      'Browse [all risks](/knowledge-base/risks/) here.',
    );
    const issues = preferEntityLinkRule.check(content as any, engineWithRegistry as any);
    expect(issues.length).toBe(0);
  });

  it('warning issue has no auto-fix', () => {
    const content = mockContent(
      'See [Unknown](/knowledge-base/some-unknown-page/) for more.',
    );
    const issues = preferEntityLinkRule.check(content as any, engineWithRegistry as any);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe(Severity.WARNING);
    expect(issues[0].fix).toBeNull();
  });

  it('auto-fix uses numeric+name format for registered entities', () => {
    const content = mockContent(
      'See [Community Notes](/knowledge-base/responses/community-notes-for-everything/) for more.',
    );
    const issues = preferEntityLinkRule.check(content as any, engineWithRegistry as any);
    expect(issues.length).toBe(1);
    expect(issues[0].fix).not.toBeNull();
    expect(issues[0].fix!.newText).toBe(
      '<EntityLink id="E300" name="community-notes-for-everything">Community Notes</EntityLink>'
    );
  });
});

// =============================================================================
// entitylink-ids rule
// =============================================================================

import { entityLinkIdsRule } from './entitylink-ids.ts';

describe('entitylink-ids rule', () => {
  const engineWithRegistry = {
    idRegistry: {
      bySlug: {
        'anthropic': 'E42',
        'nick-bostrom': 'E140',
        'miri': 'E100',
      },
      byNumericId: {
        'E42': 'anthropic',
        'E140': 'nick-bostrom',
        'E100': 'miri',
      },
    },
    pathRegistry: {
      'anthropic': '/knowledge-base/organizations/anthropic/',
      'nick-bostrom': '/knowledge-base/people/nick-bostrom/',
      'miri': '/knowledge-base/organizations/miri/',
    },
    entities: {
      'anthropic': { type: 'organization' },
      'nick-bostrom': { type: 'person' },
      'miri': { type: 'organization' },
    },
  };

  it('warns when slug ID used instead of numeric ID, with auto-fix to numeric+name', () => {
    const content = mockContent(
      '<EntityLink id="anthropic">Anthropic</EntityLink>',
    );
    const issues = entityLinkIdsRule.check(content as any, engineWithRegistry as any);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe(Severity.WARNING);
    expect(issues[0].message).toContain('use numeric format');
    expect(issues[0].fix).not.toBeNull();
    expect(issues[0].fix!.oldText).toBe('id="anthropic"');
    expect(issues[0].fix!.newText).toBe('id="E42" name="anthropic"');
  });

  it('passes for numeric ID with correct name', () => {
    const content = mockContent(
      '<EntityLink id="E42" name="anthropic">Anthropic</EntityLink>',
    );
    const issues = entityLinkIdsRule.check(content as any, engineWithRegistry as any);
    expect(issues.length).toBe(0);
  });

  it('errors when numeric ID has wrong name (hallucination catch)', () => {
    const content = mockContent(
      '<EntityLink id="E42" name="miri">MIRI</EntityLink>',
    );
    const issues = entityLinkIdsRule.check(content as any, engineWithRegistry as any);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe(Severity.ERROR);
    expect(issues[0].message).toContain('name mismatch');
    expect(issues[0].message).toContain('"anthropic"');
    expect(issues[0].fix).not.toBeNull();
    expect(issues[0].fix!.oldText).toBe('name="miri"');
    expect(issues[0].fix!.newText).toBe('name="anthropic"');
  });

  it('warns when numeric ID used without name, with auto-fix to add name', () => {
    const content = mockContent(
      '<EntityLink id="E140">Nick Bostrom</EntityLink>',
    );
    const issues = entityLinkIdsRule.check(content as any, engineWithRegistry as any);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe(Severity.WARNING);
    expect(issues[0].message).toContain('add name="nick-bostrom"');
    expect(issues[0].fix).not.toBeNull();
    expect(issues[0].fix!.oldText).toBe('id="E140"');
    expect(issues[0].fix!.newText).toBe('id="E140" name="nick-bostrom"');
  });

  it('warns for unregistered numeric ID', () => {
    const content = mockContent(
      '<EntityLink id="E9999">Unknown</EntityLink>',
    );
    const issues = entityLinkIdsRule.check(content as any, engineWithRegistry as any);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe(Severity.WARNING);
    expect(issues[0].message).toContain('not a registered numeric ID');
  });

  it('warns for slug ID that does not resolve', () => {
    const content = mockContent(
      '<EntityLink id="nonexistent-entity">Ghost</EntityLink>',
    );
    const issues = entityLinkIdsRule.check(content as any, engineWithRegistry as any);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe(Severity.WARNING);
    expect(issues[0].message).toContain('does not resolve');
  });

  it('skips internal documentation pages', () => {
    const content = mockContent(
      '<EntityLink id="anthropic">Anthropic</EntityLink>',
      { relativePath: 'docs/internal/some-guide.mdx' },
    );
    const issues = entityLinkIdsRule.check(content as any, engineWithRegistry as any);
    expect(issues.length).toBe(0);
  });
});

