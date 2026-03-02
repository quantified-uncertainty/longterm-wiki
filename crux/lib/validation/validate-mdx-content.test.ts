import { describe, it, expect } from 'vitest';
import { validateMdxContent } from './validate-mdx-content.ts';

describe('validateMdxContent', () => {
  it('accepts valid MDX with frontmatter', () => {
    const content = `---
title: Test Page
quality: 70
---

## Section

Some content here.
`;
    expect(validateMdxContent(content)).toEqual({ valid: true });
  });

  it('rejects empty content', () => {
    expect(validateMdxContent('')).toEqual({ valid: false, error: 'Content is empty' });
    expect(validateMdxContent('   \n  ')).toEqual({ valid: false, error: 'Content is empty' });
  });

  it('rejects JSON blob starting with {', () => {
    const json = `{"content": "## Section\\nSome text", "claimMap": []}`;
    const result = validateMdxContent(json);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('JSON');
    expect(result.error).toContain('pipeline artifact');
  });

  it('rejects JSON array starting with [', () => {
    const json = `[{"claim": "something", "source": "url"}]`;
    const result = validateMdxContent(json);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('JSON');
  });

  it('rejects JSON wrapper with content field', () => {
    const wrapped = `  {"content": "---\\ntitle: Test\\n---\\n## Section", "claimMap": []}`;
    const result = validateMdxContent(wrapped);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('pipeline artifact');
  });

  it('rejects frontmatter with no closing delimiter', () => {
    const lines = ['---', 'title: Broken'];
    // Add 110 lines of content without a closing ---
    for (let i = 0; i < 110; i++) lines.push(`line ${i}`);
    const result = validateMdxContent(lines.join('\n'));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('closing `---`');
  });

  it('accepts content without frontmatter (e.g., index pages)', () => {
    const content = `# Simple Index\n\nSome content.\n`;
    expect(validateMdxContent(content)).toEqual({ valid: true });
  });

  it('accepts frontmatter with closing delimiter on line 50', () => {
    const lines = ['---'];
    for (let i = 0; i < 48; i++) lines.push(`field${i}: value`);
    lines.push('---', '', '## Content');
    expect(validateMdxContent(lines.join('\n'))).toEqual({ valid: true });
  });

  it('handles leading whitespace before frontmatter', () => {
    const content = `\n\n---\ntitle: Test\n---\n\n## Section\n`;
    expect(validateMdxContent(content)).toEqual({ valid: true });
  });
});
