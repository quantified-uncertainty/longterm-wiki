/**
 * Unit Tests for Style Guide Validation Rule
 */

import { describe, it, expect } from 'vitest';
import { Issue, Severity, type Rule } from '../validation/validation-engine.ts';
import { styleGuideRule } from './style-guide.ts';

function mockContent(body: string, opts: Record<string, unknown> = {}): any {
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

function check(rule: Rule, content: any, engine: any = {}): Issue[] {
  const result = rule.check(content, engine);
  if (result instanceof Promise) throw new Error('Unexpected Promise');
  return result;
}

describe('style-guide rule', () => {
  describe('section structure', () => {
    it('flags missing required Overview section for model pages', () => {
      const content = mockContent(
        '## Some Section\n\nContent here.',
        { path: 'content/docs/knowledge-base/models/test-model.mdx' },
      );
      const issues = check(styleGuideRule, content);
      const sectionIssues = issues.filter(i => i.message.includes('Missing required section'));
      expect(sectionIssues.length).toBeGreaterThan(0);
      expect(sectionIssues[0].message).toContain('Overview');
    });

    it('does not flag when Overview section exists', () => {
      const content = mockContent(
        '## Overview\n\nThis model analyzes X.\n\n## Details\n\nMore info.',
        {
          path: 'content/docs/knowledge-base/models/test-model.mdx',
          frontmatter: { title: 'Test Model', description: 'This model estimates that 50% of X.' },
        },
      );
      const issues = check(styleGuideRule, content);
      const sectionIssues = issues.filter(i => i.message.includes('Missing required section'));
      expect(sectionIssues.length).toBe(0);
    });

    it('flags missing Overview for risk pages', () => {
      const content = mockContent(
        '## Risk Assessment\n\nHigh risk.',
        { path: 'content/docs/knowledge-base/risks/test-risk.mdx' },
      );
      const issues = check(styleGuideRule, content);
      const sectionIssues = issues.filter(i => i.message.includes('Missing required section'));
      expect(sectionIssues.length).toBeGreaterThan(0);
    });
  });

  describe('mechanism without magnitude (models)', () => {
    it('flags model without strategic importance', () => {
      const content = mockContent(
        '## Overview\n\nThis model describes mechanisms.\n\n## How It Works\n\nDetails.',
        {
          path: 'content/docs/knowledge-base/models/test-model.mdx',
          frontmatter: { title: 'Test', description: 'This model estimates that 50% of risk.' },
        },
      );
      const issues = check(styleGuideRule, content);
      const magnitudeIssues = issues.filter(i => i.message.includes('magnitude'));
      expect(magnitudeIssues.length).toBeGreaterThan(0);
    });

    it('does not flag model with strategic importance section', () => {
      const content = mockContent(
        '## Overview\n\nContent.\n\n## Strategic Importance\n\nThis accounts for 10-30% of risk.',
        {
          path: 'content/docs/knowledge-base/models/test-model.mdx',
          frontmatter: { title: 'Test', description: 'This model estimates that 50% of risk.' },
        },
      );
      const issues = check(styleGuideRule, content);
      const magnitudeIssues = issues.filter(i => i.message.includes('magnitude'));
      expect(magnitudeIssues.length).toBe(0);
    });
  });

  describe('hierarchy check', () => {
    it('flags flat hierarchy with 10+ h2 and few h3', () => {
      const sections = Array.from({ length: 12 }, (_, i) => `## Section ${i}\n\nContent.`).join('\n\n');
      const content = mockContent(sections);
      const issues = check(styleGuideRule, content);
      const hierarchyIssues = issues.filter(i => i.message.includes('h2 sections'));
      expect(hierarchyIssues.length).toBe(1);
      expect(hierarchyIssues[0].severity).toBe(Severity.INFO);
    });

    it('does not flag when h3 subsections are present', () => {
      const sections = Array.from({ length: 12 }, (_, i) =>
        `## Section ${i}\n\n### Sub ${i}a\n\nContent.\n\n### Sub ${i}b\n\nMore.`
      ).join('\n\n');
      const content = mockContent(sections);
      const issues = check(styleGuideRule, content);
      const hierarchyIssues = issues.filter(i => i.message.includes('h2 sections'));
      expect(hierarchyIssues.length).toBe(0);
    });
  });

  describe('Mermaid diagram checks', () => {
    it('flags diagrams with too many nodes', () => {
      const nodes = Array.from({ length: 20 }, (_, i) => `A${i}[Node ${i}]`).join('\n');
      const chart = `flowchart TD\n${nodes}`;
      const content = mockContent(`<Mermaid chart={\`${chart}\`} />`);
      const issues = check(styleGuideRule, content);
      const nodeIssues = issues.filter(i => i.message.includes('nodes'));
      expect(nodeIssues.length).toBeGreaterThan(0);
    });
  });

  describe('skips', () => {
    it('skips style guide pages', () => {
      const content = mockContent(
        '## Some broken page',
        { path: 'content/docs/internal/style-guides/models.mdx' },
      );
      const issues = check(styleGuideRule, content);
      expect(issues.length).toBe(0);
    });

    it('skips index pages', () => {
      const content = mockContent(
        '## Some page',
        { path: 'content/docs/knowledge-base/models/index.mdx', isIndex: true },
      );
      const issues = check(styleGuideRule, content);
      expect(issues.length).toBe(0);
    });
  });

  describe('model description quality', () => {
    it('flags missing model description', () => {
      const content = mockContent(
        '## Overview\n\nContent.\n\n## Strategic Importance\n\n10-30% of risk.',
        {
          path: 'content/docs/knowledge-base/models/test-model.mdx',
          frontmatter: { title: 'Test' },
        },
      );
      const issues = check(styleGuideRule, content);
      const descIssues = issues.filter(i => i.message.includes('description'));
      expect(descIssues.length).toBeGreaterThan(0);
    });

    it('flags description without conclusions', () => {
      const content = mockContent(
        '## Overview\n\nContent.\n\n## Strategic Importance\n\n10-30% of risk.',
        {
          path: 'content/docs/knowledge-base/models/test-model.mdx',
          frontmatter: { title: 'Test', description: 'A model about something.' },
        },
      );
      const issues = check(styleGuideRule, content);
      const conclusionIssues = issues.filter(i => i.message.includes('conclusion'));
      expect(conclusionIssues.length).toBeGreaterThan(0);
    });

    it('accepts description with quantified findings', () => {
      const content = mockContent(
        '## Overview\n\nContent.\n\n## Strategic Importance\n\n10-30% of risk.',
        {
          path: 'content/docs/knowledge-base/models/test-model.mdx',
          frontmatter: {
            title: 'Test',
            description: 'This model estimates that alignment difficulty accounts for 20-40% of total x-risk.',
            ratings: { novelty: 5, rigor: 6, actionability: 4, completeness: 7 },
          },
        },
      );
      const issues = check(styleGuideRule, content);
      const conclusionIssues = issues.filter(i => i.message.includes('conclusion'));
      expect(conclusionIssues.length).toBe(0);
    });
  });
});
