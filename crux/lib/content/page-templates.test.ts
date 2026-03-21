import { describe, it, expect } from 'vitest';
import {
  PAGE_TEMPLATES,
  resolveTemplate,
  formatTemplateForPrompt,
} from './page-templates.ts';

describe('resolveTemplate', () => {
  it('resolves explicit pageTemplate from frontmatter', () => {
    const t = resolveTemplate('knowledge-base-risk');
    expect(t).not.toBeNull();
    expect(t!.id).toBe('knowledge-base-risk');
  });

  it('resolves from entity type when pageTemplate is absent', () => {
    const t = resolveTemplate(undefined, 'person');
    expect(t).not.toBeNull();
    expect(t!.id).toBe('knowledge-base-person');
  });

  it('explicit pageTemplate takes precedence over entityType', () => {
    const t = resolveTemplate('knowledge-base-risk', 'person');
    expect(t!.id).toBe('knowledge-base-risk');
  });

  it('returns null for unknown entity type', () => {
    expect(resolveTemplate(undefined, 'unknown-type')).toBeNull();
  });

  it('returns null when both are absent', () => {
    expect(resolveTemplate(undefined, undefined)).toBeNull();
  });

  it('maps all expected entity types to templates', () => {
    const mappings: Record<string, string> = {
      risk: 'knowledge-base-risk',
      approach: 'knowledge-base-response',
      response: 'knowledge-base-response',
      model: 'knowledge-base-model',
      analysis: 'knowledge-base-model',
      concept: 'knowledge-base-concept',
      person: 'knowledge-base-person',
      organization: 'knowledge-base-organization',
      overview: 'knowledge-base-overview',
    };
    for (const [entityType, templateId] of Object.entries(mappings)) {
      const t = resolveTemplate(undefined, entityType);
      expect(t, `${entityType} should resolve to ${templateId}`).not.toBeNull();
      expect(t!.id).toBe(templateId);
    }
  });
});

describe('formatTemplateForPrompt', () => {
  it('includes template name', () => {
    const t = PAGE_TEMPLATES['knowledge-base-risk'];
    const output = formatTemplateForPrompt(t);
    expect(output).toContain('Template: Knowledge Base - Risk');
  });

  it('includes minimum word count', () => {
    const t = PAGE_TEMPLATES['knowledge-base-risk'];
    const output = formatTemplateForPrompt(t);
    expect(output).toContain('Minimum word count: 800');
  });

  it('lists required sections', () => {
    const t = PAGE_TEMPLATES['knowledge-base-risk'];
    const output = formatTemplateForPrompt(t);
    expect(output).toContain('Required sections');
    expect(output).toContain('Overview');
    expect(output).toContain('Risk Assessment');
    expect(output).toContain('How It Works');
    expect(output).toContain('Responses');
    expect(output).toContain('Key Uncertainties');
  });

  it('lists alternate labels for sections', () => {
    const t = PAGE_TEMPLATES['knowledge-base-risk'];
    const output = formatTemplateForPrompt(t);
    expect(output).toContain('(or: Mechanisms');
  });

  it('lists optional sections separately', () => {
    const t = PAGE_TEMPLATES['knowledge-base-person'];
    const output = formatTemplateForPrompt(t);
    expect(output).toContain('Optional sections');
    expect(output).toContain('Criticism');
  });

  it('lists quality criteria (excluding word-count)', () => {
    const t = PAGE_TEMPLATES['knowledge-base-risk'];
    const output = formatTemplateForPrompt(t);
    expect(output).toContain('Quality criteria');
    expect(output).toContain('Has Risk Assessment Table');
    expect(output).toContain('Has Citations');
    // word-count is excluded from display
    expect(output).not.toContain('Sufficient Length');
  });

  it('handles templates with no sections', () => {
    const t = PAGE_TEMPLATES['data-table'];
    const output = formatTemplateForPrompt(t);
    expect(output).toContain('Template: Interactive Data Table');
    expect(output).not.toContain('Required sections');
  });
});
