/**
 * Unit tests for the resource-ref-integrity rule.
 *
 * Mocks resource-io so tests run deterministically without reading actual files.
 */

import { describe, it, expect, vi } from 'vitest';
import { Severity } from '../validation/validation-engine.ts';

// Mock resource-io.ts to return test resource IDs (including stable_ids)
vi.mock('../../resource-io.ts', () => ({
  loadResourceIdsPGFirst: vi.fn(async () =>
    new Set(['aabbccdd11223344', 'ccdd1122aabb5566', 'aB1cD2eF3g']),
  ),
}));

// Import AFTER vi.mock so the mocked module is used.
import { resourceRefIntegrityRule } from './resource-ref-integrity.ts';

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

describe('resource-ref-integrity rule', () => {
  it('passes when resource ID exists', async () => {
    const content = mockContent('<R id="aabbccdd11223344">Valid Resource</R>');
    const issues = await resourceRefIntegrityRule.check(content as any, {} as any);
    expect(issues.length).toBe(0);
  });

  it('reports an error for an unknown resource ID', async () => {
    const content = mockContent('<R id="deadbeefdeadbeef">Missing Resource</R>');
    const issues = await resourceRefIntegrityRule.check(content as any, {} as any);
    expect(issues.length).toBe(1);
    expect(issues[0].rule).toBe('resource-ref-integrity');
    expect(issues[0].message).toContain('deadbeefdeadbeef');
    expect(issues[0].severity).toBe(Severity.ERROR);
  });

  it('reports the correct line number for the broken reference', async () => {
    const body = 'First line\nSecond line\n<R id="deadbeefdeadbeef">Missing</R>\nFourth line';
    const content = mockContent(body);
    const issues = await resourceRefIntegrityRule.check(content as any, {} as any);
    expect(issues.length).toBe(1);
    expect(issues[0].line).toBe(3);
  });

  it('skips <R> tags inside fenced code blocks', async () => {
    const body = '```\n<R id="deadbeefdeadbeef">Missing</R>\n```';
    const content = mockContent(body);
    const issues = await resourceRefIntegrityRule.check(content as any, {} as any);
    expect(issues.length).toBe(0);
  });

  it('skips <R> tags inside inline code spans', async () => {
    const body = 'Use `<R id="deadbeefdeadbeef">text</R>` in your page.';
    const content = mockContent(body);
    const issues = await resourceRefIntegrityRule.check(content as any, {} as any);
    expect(issues.length).toBe(0);
  });

  it('skips pages whose relativePath starts with internal/', async () => {
    const content = mockContent('<R id="deadbeefdeadbeef">Missing</R>', {
      relativePath: 'internal/guide.mdx',
    });
    const issues = await resourceRefIntegrityRule.check(content as any, {} as any);
    expect(issues.length).toBe(0);
  });

  it('skips pages with /internal/ anywhere in relativePath', async () => {
    const content = mockContent('<R id="deadbeefdeadbeef">Missing</R>', {
      relativePath: 'docs/internal/some-guide.mdx',
    });
    const issues = await resourceRefIntegrityRule.check(content as any, {} as any);
    expect(issues.length).toBe(0);
  });

  it('reports one error per broken reference across multiple lines', async () => {
    const body = [
      '<R id="deadbeefdeadbeef">Missing 1</R>',
      'Some text',
      '<R id="baadf00dbaadf00d">Missing 2</R>',
    ].join('\n');
    const content = mockContent(body);
    const issues = await resourceRefIntegrityRule.check(content as any, {} as any);
    expect(issues.length).toBe(2);
  });

  it('only errors on the invalid ID when page has both valid and invalid references', async () => {
    const body = [
      '<R id="aabbccdd11223344">Valid</R>',
      'Some text',
      '<R id="deadbeefdeadbeef">Invalid</R>',
    ].join('\n');
    const content = mockContent(body);
    const issues = await resourceRefIntegrityRule.check(content as any, {} as any);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('deadbeefdeadbeef');
  });

  it('accepts both valid IDs', async () => {
    const body = [
      '<R id="aabbccdd11223344">Resource A</R>',
      '<R id="ccdd1122aabb5566">Resource B</R>',
    ].join('\n');
    const content = mockContent(body);
    const issues = await resourceRefIntegrityRule.check(content as any, {} as any);
    expect(issues.length).toBe(0);
  });

  it('accepts a stable_id in <R> tag', async () => {
    const content = mockContent('<R id="aB1cD2eF3g">Resource via stable_id</R>');
    const issues = await resourceRefIntegrityRule.check(content as any, {} as any);
    expect(issues.length).toBe(0);
  });
});
