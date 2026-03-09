/**
 * Unit tests for the no-deprecated-components rule.
 *
 * Verifies that the old `<F e="..." f="...">` fact component syntax is caught
 * while legitimate uses (code blocks, internal pages, KBF) are not flagged.
 */

import { describe, it, expect } from 'vitest';
import { noDeprecatedComponentsRule } from './no-deprecated-components.ts';
import { Severity } from '../validation/validation-engine.ts';

function mockContent(
  body: string,
  opts: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    path: (opts.path as string) ?? 'content/docs/test-page.mdx',
    relativePath: (opts.relativePath as string) ?? 'test-page.mdx',
    body,
    raw: `---\ntitle: Test\n---\n${body}`,
    frontmatter: { title: 'Test Page' },
    isIndex: false,
  };
}

describe('no-deprecated-components rule', () => {
  it('passes on clean MDX with no deprecated components', async () => {
    const content = mockContent('## Overview\n\nThis is a clean page with no deprecated components.');
    const issues = await noDeprecatedComponentsRule.check(content as any, {} as any);
    expect(issues.length).toBe(0);
  });

  it('reports ERROR for <F e="..." f="..."> usage', async () => {
    const content = mockContent('Revenue is <F e="anthropic" f="6796e194">\\$380B</F>.');
    const issues = await noDeprecatedComponentsRule.check(content as any, {} as any);
    expect(issues.length).toBe(1);
    expect(issues[0].rule).toBe('no-deprecated-components');
    expect(issues[0].severity).toBe(Severity.ERROR);
    expect(issues[0].message).toContain('Deprecated <F>');
    expect(issues[0].message).toContain('KBF');
  });

  it('reports ERROR for <F f="..." e="..."> (reversed attribute order)', async () => {
    const content = mockContent('Revenue is <F f="6796e194" e="anthropic">\\$380B</F>.');
    const issues = await noDeprecatedComponentsRule.check(content as any, {} as any);
    expect(issues.length).toBe(1);
    expect(issues[0].rule).toBe('no-deprecated-components');
    expect(issues[0].severity).toBe(Severity.ERROR);
  });

  it('reports ERROR for self-closing <F e="..." /> syntax', async () => {
    const content = mockContent('The valuation is <F e="anthropic" f="6796e194" />.');
    const issues = await noDeprecatedComponentsRule.check(content as any, {} as any);
    expect(issues.length).toBe(1);
  });

  it('skips <F> usage inside fenced code blocks', async () => {
    const body = '```\n<F e="anthropic" f="6796e194">\\$380B</F>\n```';
    const content = mockContent(body);
    const issues = await noDeprecatedComponentsRule.check(content as any, {} as any);
    expect(issues.length).toBe(0);
  });

  it('skips <F> usage inside inline code spans', async () => {
    const body = 'Use `<F e="entity" f="fact">display</F>` syntax for old facts.';
    const content = mockContent(body);
    const issues = await noDeprecatedComponentsRule.check(content as any, {} as any);
    expect(issues.length).toBe(0);
  });

  it('skips internal/ pages', async () => {
    const content = mockContent('<F e="anthropic" f="6796e194">\\$380B</F>', {
      relativePath: 'internal/data-system-authority.mdx',
    });
    const issues = await noDeprecatedComponentsRule.check(content as any, {} as any);
    expect(issues.length).toBe(0);
  });

  it('skips pages with /internal/ anywhere in relativePath', async () => {
    const content = mockContent('<F e="anthropic" f="6796e194">\\$380B</F>', {
      relativePath: 'docs/internal/migration-guide.mdx',
    });
    const issues = await noDeprecatedComponentsRule.check(content as any, {} as any);
    expect(issues.length).toBe(0);
  });

  it('does NOT flag <KBF entity="..." property="..." /> (the replacement)', async () => {
    const content = mockContent('<KBF entity="anthropic" property="valuation" />');
    const issues = await noDeprecatedComponentsRule.check(content as any, {} as any);
    expect(issues.length).toBe(0);
  });

  it('does NOT flag generic <F> without e= or f= attributes', async () => {
    const content = mockContent('The formula is F = ma.');
    const issues = await noDeprecatedComponentsRule.check(content as any, {} as any);
    expect(issues.length).toBe(0);
  });

  it('reports correct line number', async () => {
    const body = 'First line\nSecond line\n<F e="anthropic" f="revenue">\\$1B</F>\nFourth line';
    const content = mockContent(body);
    const issues = await noDeprecatedComponentsRule.check(content as any, {} as any);
    expect(issues.length).toBe(1);
    expect(issues[0].line).toBe(3);
  });

  it('reports multiple errors for multiple deprecated usages', async () => {
    const body = [
      '<F e="anthropic" f="revenue">\\$1B</F>',
      'Some text',
      '<F e="openai" f="valuation">\\$100B</F>',
    ].join('\n');
    const content = mockContent(body);
    const issues = await noDeprecatedComponentsRule.check(content as any, {} as any);
    expect(issues.length).toBe(2);
  });
});
