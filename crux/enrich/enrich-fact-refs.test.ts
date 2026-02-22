/**
 * Unit tests for Fact Reference enrichment tool.
 *
 * Tests cover:
 * - applyFactRefReplacements: core replacement logic (no LLM needed)
 * - Idempotency: running twice doesn't double-wrap
 * - Skip ranges: code blocks, frontmatter, existing <F> tags
 * - First-occurrence-only replacement
 */

import { describe, it, expect } from 'vitest';
import { applyFactRefReplacements, type FactRefReplacement } from './enrich-fact-refs.ts';

describe('applyFactRefReplacements', () => {
  it('wraps a matching number with <F> tags', () => {
    const content = 'Anthropic raised \\$30 billion in its latest funding round.';
    const replacements: FactRefReplacement[] = [
      { searchText: '\\$30 billion', entityId: 'anthropic', factId: '5b0663a0', displayText: '\\$30 billion' },
    ];

    const { content: result, applied } = applyFactRefReplacements(content, replacements);

    expect(applied).toBe(1);
    expect(result).toContain('<F e="anthropic" f="5b0663a0">\\$30 billion</F>');
    expect(result).not.toMatch(/(?<!<F[^>]*>)\\?\$30 billion(?!<\/F>)/);
  });

  it('is idempotent: does not double-wrap already wrapped numbers', () => {
    const content = 'Anthropic raised <F e="anthropic" f="5b0663a0">\\$30 billion</F> in 2024.';
    const replacements: FactRefReplacement[] = [
      { searchText: '\\$30 billion', entityId: 'anthropic', factId: '5b0663a0', displayText: '\\$30 billion' },
    ];

    const { content: result, applied } = applyFactRefReplacements(content, replacements);

    // "\\$30 billion" is inside F tag, should be in a skip range
    // No new F tags should be added
    const matches = [...result.matchAll(/<F\s/g)];
    expect(matches.length).toBe(1);
    expect(applied).toBe(0);
  });

  it('skips numbers inside self-closing <F /> tags', () => {
    const content = 'The valuation is <F e="anthropic" f="6796e194" /> as of Feb 2026.';
    const replacements: FactRefReplacement[] = [
      { searchText: 'anthropic', entityId: 'anthropic', factId: '6796e194', displayText: '\\$380B' },
    ];

    const { content: result, applied } = applyFactRefReplacements(content, replacements);

    // The self-closing F tag shouldn't be affected
    expect(result).toContain('<F e="anthropic" f="6796e194" />');
  });

  it('skips numbers inside code blocks', () => {
    const content = '```\nconst budget = "$30 billion";\n```\n\nAnthropics raised \\$30 billion.';
    const replacements: FactRefReplacement[] = [
      { searchText: '\\$30 billion', entityId: 'anthropic', factId: '5b0663a0', displayText: '\\$30 billion' },
    ];

    const { content: result } = applyFactRefReplacements(content, replacements);

    // The code block content should be untouched
    expect(result).toContain('```\nconst budget = "$30 billion";\n```');
  });

  it('skips numbers inside inline code', () => {
    const content = 'Use `\\$30 billion` as the value. Anthropic raised \\$30 billion.';
    const replacements: FactRefReplacement[] = [
      { searchText: '\\$30 billion', entityId: 'anthropic', factId: '5b0663a0', displayText: '\\$30 billion' },
    ];

    const { content: result } = applyFactRefReplacements(content, replacements);

    // Inline code should be preserved
    expect(result).toContain('`\\$30 billion`');
  });

  it('skips numbers inside frontmatter', () => {
    const content = `---
title: "$30 billion Funding"
---

Anthropic raised \\$30 billion.`;
    const replacements: FactRefReplacement[] = [
      { searchText: '\\$30 billion', entityId: 'anthropic', factId: '5b0663a0', displayText: '\\$30 billion' },
    ];

    const { content: result } = applyFactRefReplacements(content, replacements);

    // Frontmatter should be preserved
    expect(result).toContain('title: "$30 billion Funding"');
    // Body occurrence should be wrapped
    expect(result).toContain('<F e="anthropic" f="5b0663a0">\\$30 billion</F>');
  });

  it('applies multiple different fact replacements', () => {
    const content = 'Anthropic has \\$30 billion in funding and \\$380 billion valuation.';
    const replacements: FactRefReplacement[] = [
      { searchText: '\\$30 billion', entityId: 'anthropic', factId: '5b0663a0', displayText: '\\$30 billion' },
      { searchText: '\\$380 billion', entityId: 'anthropic', factId: '6796e194', displayText: '\\$380 billion' },
    ];

    const { content: result, applied } = applyFactRefReplacements(content, replacements);

    expect(applied).toBe(2);
    expect(result).toContain('<F e="anthropic" f="5b0663a0">\\$30 billion</F>');
    expect(result).toContain('<F e="anthropic" f="6796e194">\\$380 billion</F>');
  });

  it('returns 0 applied when searchText not found', () => {
    const content = 'OpenAI raised a lot of money.';
    const replacements: FactRefReplacement[] = [
      { searchText: '\\$30 billion', entityId: 'anthropic', factId: '5b0663a0', displayText: '\\$30 billion' },
    ];

    const { content: result, applied } = applyFactRefReplacements(content, replacements);

    expect(applied).toBe(0);
    expect(result).toBe(content);
  });

  it('handles empty replacements array gracefully', () => {
    const content = 'Anthropic raised a lot of money.';
    const replacements: FactRefReplacement[] = [];

    const { content: result, applied } = applyFactRefReplacements(content, replacements);

    expect(applied).toBe(0);
    expect(result).toBe(content);
  });

  it('preserves surrounding text correctly', () => {
    const content = 'In 2024, Anthropic raised \\$30 billion from investors.';
    const replacements: FactRefReplacement[] = [
      { searchText: '\\$30 billion', entityId: 'anthropic', factId: '5b0663a0', displayText: '\\$30 billion' },
    ];

    const { content: result } = applyFactRefReplacements(content, replacements);

    expect(result).toBe('In 2024, Anthropic raised <F e="anthropic" f="5b0663a0">\\$30 billion</F> from investors.');
  });

  it('skips numbers inside <Calc> tags', () => {
    const content = 'The ratio is <Calc expr="{anthropic.6796e194} / {anthropic.5b0663a0}" precision={0} suffix="x" />.';
    const replacements: FactRefReplacement[] = [
      { searchText: '6796e194', entityId: 'anthropic', factId: '6796e194', displayText: '6796e194' },
    ];

    const { content: result } = applyFactRefReplacements(content, replacements);

    // The Calc tag content should be preserved (skip range covers Calc tags)
    expect(result).toContain('<Calc expr="{anthropic.6796e194}');
  });
});
