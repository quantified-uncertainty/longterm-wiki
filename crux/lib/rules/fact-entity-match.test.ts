/**
 * Tests for the fact-entity-match validation rule.
 *
 * These tests mock the facts directory to control which entities have facts,
 * then verify the rule correctly detects cross-entity <F> references.
 */

import { describe, it, expect, vi } from 'vitest';
import { Issue, type Rule } from '../validation-engine.ts';
import { factEntityMatchRule } from './fact-entity-match.ts';

/**
 * Create a mock content file for testing.
 */
function mockContent(body: string, opts: Record<string, unknown> = {}): any {
  return {
    path: opts.path || 'content/docs/knowledge-base/organizations/anthropic.mdx',
    relativePath: opts.relativePath || 'knowledge-base/organizations/anthropic.mdx',
    body,
    raw: `---\ntitle: Test Page\n---\n${body}`,
    frontmatter: opts.frontmatter || { title: 'Test Page' },
    isIndex: false,
  };
}

function check(rule: Rule, content: any): Issue[] {
  const result = rule.check(content, {} as any);
  if (result instanceof Promise) {
    throw new Error('Expected synchronous check');
  }
  return result as Issue[];
}

// Mock fs to control which fact entity files exist
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    readdirSync: vi.fn((dir: string) => {
      if (dir.endsWith('data/facts')) {
        return ['anthropic.yaml', 'openai.yaml', 'jaan-tallinn.yaml', 'sam-altman.yaml'];
      }
      return (actual.readdirSync as Function)(dir);
    }),
    existsSync: vi.fn((path: string) => {
      if (path.endsWith('data/facts')) return true;
      return (actual.existsSync as Function)(path);
    }),
  };
});

describe('fact-entity-match', () => {
  it('passes when <F> entity matches page slug', () => {
    const content = mockContent(
      'Anthropic is valued at <F e="anthropic" f="6796e194">\\$380B</F>.',
      { relativePath: 'knowledge-base/organizations/anthropic.mdx' }
    );
    const issues = check(factEntityMatchRule, content);
    expect(issues).toHaveLength(0);
  });

  it('warns when <F> entity differs from page slug (page has own facts)', () => {
    const content = mockContent(
      'OpenAI raised <F e="anthropic" f="5b0663a0">\\$30B</F> in funding.',
      { relativePath: 'knowledge-base/organizations/openai.mdx' }
    );
    const issues = check(factEntityMatchRule, content);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('e="anthropic"');
    expect(issues[0].message).toContain('page "openai"');
  });

  it('skips pages without own facts (person pages without fact files)', () => {
    const content = mockContent(
      'Daniela Amodei leads <F e="anthropic" f="6796e194">\\$380B</F> Anthropic.',
      { relativePath: 'knowledge-base/people/daniela-amodei.mdx' }
    );
    const issues = check(factEntityMatchRule, content);
    expect(issues).toHaveLength(0);
  });

  it('skips internal pages', () => {
    const content = mockContent(
      '<F e="anthropic" f="6796e194">\\$380B</F> on an internal doc.',
      { relativePath: 'internal/canonical-facts.mdx' }
    );
    const issues = check(factEntityMatchRule, content);
    expect(issues).toHaveLength(0);
  });

  it('detects multiple cross-entity references', () => {
    const content = mockContent(
      'OpenAI has <F e="anthropic" f="6796e194">\\$380B</F> and <F e="sam-altman" f="abc">738</F>.',
      { relativePath: 'knowledge-base/organizations/openai.mdx' }
    );
    const issues = check(factEntityMatchRule, content);
    expect(issues).toHaveLength(2);
  });

  it('handles self-closing <F> tags', () => {
    const content = mockContent(
      '<F e="anthropic" f="6796e194" />',
      { relativePath: 'knowledge-base/organizations/openai.mdx' }
    );
    const issues = check(factEntityMatchRule, content);
    expect(issues).toHaveLength(1);
  });

  it('passes when page has no <F> components', () => {
    const content = mockContent(
      'This page has no fact references.',
      { relativePath: 'knowledge-base/organizations/anthropic.mdx' }
    );
    const issues = check(factEntityMatchRule, content);
    expect(issues).toHaveLength(0);
  });
});
