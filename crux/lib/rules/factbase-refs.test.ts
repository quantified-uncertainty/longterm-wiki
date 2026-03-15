/**
 * Unit tests for the kbf-refs rule.
 *
 * Mocks `fs` so tests run deterministically without reading actual YAML files.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Severity } from '../validation/validation-engine.ts';

// Entity YAML file contents (slug -> YAML string)
const ENTITY_YAML: Record<string, string> = {
  'anthropic.yaml': 'thing:\n  id: anthropic\n  stableId: mK9pX3rQ7n\n  type: organization\n  name: Anthropic',
  'openai.yaml': 'thing:\n  id: openai\n  stableId: 1LcLlMGLbw\n  type: organization\n  name: OpenAI',
  'xai.yaml': 'thing:\n  id: xai\n  stableId: xAi7bC2dEf\n  type: organization\n  name: xAI',
};

const PROPERTIES_YAML = [
  'properties:',
  '  valuation:',
  '    name: Valuation',
  '  revenue:',
  '    name: Revenue',
  '  headcount:',
  '    name: Headcount',
].join('\n');

// Minimal Dirent-like objects for readdirSync({ withFileTypes: true })
function makeDirent(name: string, isFile: boolean) {
  return {
    name,
    isFile: () => isFile,
    isDirectory: () => !isFile,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    path: '',
    parentPath: '',
  };
}

// vi.mock is hoisted before all imports by vitest — fs is mocked before
// kbf-refs.ts initialises its module-level caches.
vi.mock('fs', () => ({
  readdirSync: vi.fn((_path: string, opts?: { withFileTypes?: boolean }) => {
    if (opts?.withFileTypes) {
      return [
        makeDirent('anthropic.yaml', true),
        makeDirent('openai.yaml', true),
        makeDirent('xai.yaml', true),
      ];
    }
    return ['anthropic.yaml', 'openai.yaml', 'xai.yaml'];
  }),
  readFileSync: vi.fn((filePath: string) => {
    // Return properties YAML for the properties file
    if (typeof filePath === 'string' && filePath.includes('properties.yaml')) {
      return PROPERTIES_YAML;
    }
    // Return entity YAML for individual thing files
    for (const [name, content] of Object.entries(ENTITY_YAML)) {
      if (typeof filePath === 'string' && filePath.endsWith('/' + name)) {
        return content;
      }
    }
    // Default fallback
    return PROPERTIES_YAML;
  }),
}));

// Import AFTER vi.mock so the mocked fs is used when the module initialises.
import { kbfRefsRule, _resetCache } from './factbase-refs.ts';

beforeEach(() => {
  _resetCache();
});

function mockContent(
  body: string,
  opts: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    path: (opts.path as string) ?? 'content/docs/test-page.mdx',
    relativePath: (opts.relativePath as string) ?? 'test-page.mdx',
    body,
    raw: '---\ntitle: Test\n---\n' + body,
    frontmatter: { title: 'Test Page' },
    isIndex: false,
  };
}

describe('kbf-refs rule', () => {
  // ── KBF entity checks ──────────────────────────────────────────────────

  it('passes when KBF entity and property both exist', async () => {
    const content = mockContent('<KBF entity="anthropic" property="valuation" />');
    const issues = await kbfRefsRule.check(content as any, {} as any);
    expect(issues.length).toBe(0);
  });

  it('passes for wrapping form with valid entity and property', async () => {
    const content = mockContent('<KBF entity="openai" property="revenue">$20B</KBF>');
    const issues = await kbfRefsRule.check(content as any, {} as any);
    expect(issues.length).toBe(0);
  });

  it('reports ERROR for missing entity', async () => {
    const content = mockContent('<KBF entity="nonexistent-org" property="valuation" />');
    const issues = await kbfRefsRule.check(content as any, {} as any);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe(Severity.ERROR);
    expect(issues[0].message).toContain('nonexistent-org');
    expect(issues[0].message).toContain('does not match any KB entity');
  });

  it('reports ERROR for missing property', async () => {
    const content = mockContent('<KBF entity="anthropic" property="unknown-metric" />');
    const issues = await kbfRefsRule.check(content as any, {} as any);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe(Severity.ERROR);
    expect(issues[0].message).toContain('unknown-metric');
    expect(issues[0].message).toContain('does not match any property');
  });

  it('reports two ERRORs when both entity and property are invalid', async () => {
    const content = mockContent('<KBF entity="fake-co" property="fake-prop" />');
    const issues = await kbfRefsRule.check(content as any, {} as any);
    expect(issues.length).toBe(2);
    expect(issues.every(i => i.severity === Severity.ERROR)).toBe(true);
  });

  it('handles property before entity attribute order', async () => {
    const content = mockContent('<KBF property="revenue" entity="anthropic" />');
    const issues = await kbfRefsRule.check(content as any, {} as any);
    expect(issues.length).toBe(0);
  });

  it('validates multiline KBF tags correctly', async () => {
    const body = '<KBF\n  entity="nonexistent"\n  property="valuation"\n/>';
    const content = mockContent(body);
    const issues = await kbfRefsRule.check(content as any, {} as any);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe(Severity.ERROR);
    expect(issues[0].message).toContain('nonexistent');
  });

  it('passes for multiline KBF tag with valid refs', async () => {
    const body = '<KBF\n  entity="anthropic"\n  property="valuation"\n/>';
    const content = mockContent(body);
    const issues = await kbfRefsRule.check(content as any, {} as any);
    expect(issues.length).toBe(0);
  });

  it('reports correct line number', async () => {
    const body = 'First line\nSecond line\n<KBF entity="missing" property="valuation" />\nFourth line';
    const content = mockContent(body);
    const issues = await kbfRefsRule.check(content as any, {} as any);
    expect(issues.length).toBe(1);
    expect(issues[0].line).toBe(3);
  });

  // ── stableId support ──────────────────────────────────────────────────

  it('passes when KBF entity uses a stableId instead of slug', async () => {
    const content = mockContent('<KBF entity="mK9pX3rQ7n" property="valuation" />');
    const issues = await kbfRefsRule.check(content as any, {} as any);
    expect(issues.length).toBe(0);
  });

  it('passes for Calc expressions using stableIds', async () => {
    const content = mockContent('<Calc expr="{mK9pX3rQ7n.valuation} / {mK9pX3rQ7n.revenue}" precision={0} suffix="x" />');
    const issues = await kbfRefsRule.check(content as any, {} as any);
    expect(issues.length).toBe(0);
  });

  it('passes for mixed slug and stableId Calc references', async () => {
    const content = mockContent('<Calc expr="{mK9pX3rQ7n.valuation} / {openai.revenue}" />');
    const issues = await kbfRefsRule.check(content as any, {} as any);
    expect(issues.length).toBe(0);
  });

  // ── Calc expression checks ─────────────────────────────────────────────

  it('passes for valid Calc expression references', async () => {
    const content = mockContent('<Calc expr="{anthropic.valuation} / {anthropic.revenue}" precision={0} suffix="x" />');
    const issues = await kbfRefsRule.check(content as any, {} as any);
    expect(issues.length).toBe(0);
  });

  it('reports ERROR for missing entity in Calc expression', async () => {
    const content = mockContent('<Calc expr="{missing-org.valuation} / {anthropic.revenue}" />');
    const issues = await kbfRefsRule.check(content as any, {} as any);
    const errors = issues.filter(i => i.severity === Severity.ERROR);
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain('missing-org');
  });

  it('reports ERROR for missing property in Calc expression', async () => {
    const content = mockContent('<Calc expr="{anthropic.unknown-metric}" />');
    const issues = await kbfRefsRule.check(content as any, {} as any);
    const errors = issues.filter(i => i.severity === Severity.ERROR);
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain('unknown-metric');
  });

  it('validates multiple refs in a single Calc expression', async () => {
    const content = mockContent('<Calc expr="{openai.valuation} / {anthropic.valuation}" />');
    const issues = await kbfRefsRule.check(content as any, {} as any);
    expect(issues.length).toBe(0);
  });

  // ── Fenced code block skipping ─────────────────────────────────────────

  it('skips KBF tags inside fenced code blocks', async () => {
    const body = '```\n<KBF entity="nonexistent" property="valuation" />\n```';
    const content = mockContent(body);
    const issues = await kbfRefsRule.check(content as any, {} as any);
    expect(issues.length).toBe(0);
  });

  it('skips Calc expressions inside fenced code blocks', async () => {
    const body = '```\n<Calc expr="{nonexistent.valuation}" />\n```';
    const content = mockContent(body);
    const issues = await kbfRefsRule.check(content as any, {} as any);
    expect(issues.length).toBe(0);
  });

  it('skips KBF tags inside tilde fenced blocks', async () => {
    const body = '~~~\n<KBF entity="nonexistent" property="valuation" />\n~~~';
    const content = mockContent(body);
    const issues = await kbfRefsRule.check(content as any, {} as any);
    expect(issues.length).toBe(0);
  });

  // ── Inline code span skipping ──────────────────────────────────────────

  it('skips KBF tags inside inline code spans', async () => {
    const body = 'Use `<KBF entity="nonexistent" property="valuation" />` in your page.';
    const content = mockContent(body);
    const issues = await kbfRefsRule.check(content as any, {} as any);
    expect(issues.length).toBe(0);
  });

  // ── Internal page skipping ─────────────────────────────────────────────

  it('skips pages whose relativePath starts with internal/', async () => {
    const content = mockContent('<KBF entity="nonexistent" property="valuation" />', {
      relativePath: 'internal/fact-guide.mdx',
    });
    const issues = await kbfRefsRule.check(content as any, {} as any);
    expect(issues.length).toBe(0);
  });

  it('skips pages with /internal/ anywhere in relativePath', async () => {
    const content = mockContent('<KBF entity="nonexistent" property="valuation" />', {
      relativePath: 'docs/internal/canonical-facts.mdx',
    });
    const issues = await kbfRefsRule.check(content as any, {} as any);
    expect(issues.length).toBe(0);
  });

  // ── Multiple issues on different lines ─────────────────────────────────

  it('reports one issue per broken reference across multiple lines', async () => {
    const body = [
      '<KBF entity="missing1" property="valuation" />',
      'Some text',
      '<KBF entity="missing2" property="revenue" />',
    ].join('\n');
    const content = mockContent(body);
    const issues = await kbfRefsRule.check(content as any, {} as any);
    const errors = issues.filter(i => i.severity === Severity.ERROR);
    expect(errors.length).toBe(2);
  });

  it('only errors on invalid refs when page has both valid and invalid', async () => {
    const body = [
      '<KBF entity="anthropic" property="valuation" />',
      'Some text',
      '<KBF entity="nonexistent" property="revenue" />',
    ].join('\n');
    const content = mockContent(body);
    const issues = await kbfRefsRule.check(content as any, {} as any);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('nonexistent');
  });
});
