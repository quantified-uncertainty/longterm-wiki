/**
 * Unit tests for Fact Reference enrichment tool.
 *
 * Tests cover:
 * - applyFactRefReplacements: core replacement logic (no LLM needed)
 * - Idempotency: running twice doesn't double-wrap
 * - Skip ranges: code blocks, frontmatter, existing <F> tags, markdown links
 * - First-occurrence-only replacement
 */

import { describe, it, expect } from 'vitest';
import { applyFactRefReplacements, fixDoubleNestedFTags, fixStrayBackslashBeforeFTag, type FactRefReplacement } from './enrich-fact-refs.ts';

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

  it('skips numbers inside <EntityLink> tags', () => {
    const content = 'See <EntityLink id="E42">$30B company</EntityLink> for context. Raised \\$30 billion total.';
    const replacements: FactRefReplacement[] = [
      { searchText: '\\$30 billion', entityId: 'anthropic', factId: '5b0663a0', displayText: '\\$30 billion' },
    ];

    const { content: result, applied } = applyFactRefReplacements(content, replacements);

    // The number outside EntityLink should be wrapped
    expect(applied).toBe(1);
    expect(result).toContain('<EntityLink id="E42">$30B company</EntityLink>');
    expect(result).toContain('<F e="anthropic" f="5b0663a0">\\$30 billion</F>');
  });

  it('skips numbers inside markdown link URLs', () => {
    const content = 'See [funding announcement](https://example.com/raise/30-billion) for details.';
    const replacements: FactRefReplacement[] = [
      { searchText: '30', entityId: 'anthropic', factId: '5b0663a0', displayText: '30' },
    ];

    const { content: result, applied } = applyFactRefReplacements(content, replacements);

    // The number inside the URL should not be wrapped — it would corrupt the URL
    expect(applied).toBe(0);
    expect(result).toBe(content);
  });

  it('skips numbers inside markdown link display text', () => {
    const content = 'Read the [\\$30 billion raise](https://example.com/funding) announcement.';
    const replacements: FactRefReplacement[] = [
      { searchText: '\\$30 billion', entityId: 'anthropic', factId: '5b0663a0', displayText: '\\$30 billion' },
    ];

    const { content: result, applied } = applyFactRefReplacements(content, replacements);

    // The number inside [display text](...) should not be wrapped — it would break the link syntax
    expect(applied).toBe(0);
    expect(result).toBe(content);
  });

  it('skips numbers inside markdown link URLs with nested parentheses', () => {
    const content = 'See [Wikipedia](https://en.wikipedia.org/wiki/30_billion_(amount)) for context.';
    const replacements: FactRefReplacement[] = [
      { searchText: '30', entityId: 'anthropic', factId: '5b0663a0', displayText: '30' },
    ];

    const { content: result, applied } = applyFactRefReplacements(content, replacements);

    // The number inside the URL (including in nested parens) should not be wrapped
    expect(applied).toBe(0);
    expect(result).toBe(content);
  });

  it('wraps numbers outside markdown links but not inside', () => {
    const content = 'Anthropic raised \\$30 billion. See [announcement](https://example.com/30-billion).';
    const replacements: FactRefReplacement[] = [
      { searchText: '\\$30 billion', entityId: 'anthropic', factId: '5b0663a0', displayText: '\\$30 billion' },
    ];

    const { content: result, applied } = applyFactRefReplacements(content, replacements);

    // The bare "\\$30 billion" at the start should be wrapped
    expect(applied).toBe(1);
    expect(result).toContain('<F e="anthropic" f="5b0663a0">\\$30 billion</F>');
    // The markdown link should be untouched
    expect(result).toContain('[announcement](https://example.com/30-billion)');
  });

  it('skips numbers inside reference-style markdown link [text][ref] (#687)', () => {
    const content = 'See [\\$30 billion raise][1] for details.\n\n[1]: https://example.com/funding';
    const replacements: FactRefReplacement[] = [
      { searchText: '\\$30 billion', entityId: 'anthropic', factId: '5b0663a0', displayText: '\\$30 billion' },
    ];

    const { content: result, applied } = applyFactRefReplacements(content, replacements);

    // "\\$30 billion" inside [text][ref] must not be wrapped
    expect(applied).toBe(0);
    expect(result).toBe(content);
  });

  it('skips numbers in reference-style link definition lines (#687)', () => {
    const content = 'Anthropic is a company.\n\n[1]: https://example.com/raise/2024-funding';
    const replacements: FactRefReplacement[] = [
      { searchText: '2024', entityId: 'anthropic', factId: '5b0663a0', displayText: '2024' },
    ];

    const { content: result, applied } = applyFactRefReplacements(content, replacements);

    // "2024" inside the reference definition URL must not be wrapped
    expect(applied).toBe(0);
    expect(result).toBe(content);
  });

  it('wraps numbers outside ref-style links but not inside (#687)', () => {
    const content = 'Anthropic raised \\$30 billion total. See [announcement][1].\n\n[1]: https://example.com/30-billion';
    const replacements: FactRefReplacement[] = [
      { searchText: '\\$30 billion', entityId: 'anthropic', factId: '5b0663a0', displayText: '\\$30 billion' },
    ];

    const { content: result, applied } = applyFactRefReplacements(content, replacements);

    // The bare "\\$30 billion" should be wrapped
    expect(applied).toBe(1);
    expect(result).toContain('<F e="anthropic" f="5b0663a0">\\$30 billion</F>');
    // The ref-style link should be untouched
    expect(result).toContain('[announcement][1]');
  });

  it('returns only applied replacements (not unapplied LLM proposals)', () => {
    // "\\$999 trillion" is not in content, should not appear in appliedReplacements
    const content = 'Anthropic raised \\$30 billion in 2024.';
    const replacements: FactRefReplacement[] = [
      { searchText: '\\$30 billion', entityId: 'anthropic', factId: '5b0663a0', displayText: '\\$30 billion' },
      { searchText: '\\$999 trillion', entityId: 'anthropic', factId: 'deadbeef', displayText: '\\$999 trillion' },
    ];

    const { applied, appliedReplacements } = applyFactRefReplacements(content, replacements);

    expect(applied).toBe(1);
    expect(appliedReplacements).toHaveLength(1);
    expect(appliedReplacements[0].factId).toBe('5b0663a0');
  });

  it('handles \\$ prefix mismatch: searchText without backslash, displayText with it', () => {
    // LLM sometimes returns searchText="$27–76B" but displayText="\\$27–76B"
    // Content has "\\$27–76B" — the search matches the "$27–76B" part after the backslash
    const content = 'EA-aligned capital: \\$27–76B risk-adjusted.';
    const replacements: FactRefReplacement[] = [
      { searchText: '$27–76B', entityId: 'anthropic', factId: 'a8c71e05', displayText: '\\$27–76B' },
    ];

    const { content: result, applied } = applyFactRefReplacements(content, replacements);

    expect(applied).toBe(1);
    // Should NOT leave a stray backslash before <F>
    expect(result).not.toContain('\\<F');
    expect(result).toContain('<F e="anthropic" f="a8c71e05">\\$27–76B</F>');
  });

  it('deduplicates identical searchTexts', () => {
    const content = 'Anthropic raised \\$30 billion in funding.';
    const replacements: FactRefReplacement[] = [
      { searchText: '\\$30 billion', entityId: 'anthropic', factId: '5b0663a0', displayText: '\\$30 billion' },
      { searchText: '\\$30 billion', entityId: 'anthropic', factId: '5b0663a0', displayText: '\\$30 billion' },
    ];

    const { content: result, applied } = applyFactRefReplacements(content, replacements);

    expect(applied).toBe(1);
    // Only one <F> tag, not double-nested
    const matches = [...result.matchAll(/<F\s/g)];
    expect(matches.length).toBe(1);
  });

  it('rebuilds skip ranges after each replacement (offset-independent)', () => {
    // Regression test: after wrapping "$1B" at an earlier position, wrapping a later
    // occurrence should still correctly check skip ranges on the current content
    const content = 'Revenue: \\$1B. Old valuation: <F e="anthropic" f="6796e194">\\$380B</F>. New note about \\$30B.';
    const replacements: FactRefReplacement[] = [
      { searchText: '\\$1B', entityId: 'anthropic', factId: 'bc497a3d', displayText: '\\$1B' },
      { searchText: '\\$380B', entityId: 'anthropic', factId: '6796e194', displayText: '\\$380B' },
      { searchText: '\\$30B', entityId: 'anthropic', factId: '5b0663a0', displayText: '\\$30B' },
    ];

    const { content: result, applied } = applyFactRefReplacements(content, replacements);

    // $1B should be wrapped (not in skip range)
    expect(result).toContain('<F e="anthropic" f="bc497a3d">\\$1B</F>');
    // $380B should NOT be double-wrapped (already in <F> tag)
    expect(result).not.toContain('<F e="anthropic" f="6796e194"><F');
    // $30B should be wrapped
    expect(result).toContain('<F e="anthropic" f="5b0663a0">\\$30B</F>');
    // $1B and $30B wrapped, $380B already wrapped = 2 new
    expect(applied).toBe(2);
  });
});

describe('fixDoubleNestedFTags', () => {
  it('removes double-nested <F> tags with identical attributes', () => {
    const content = '<F e="anthropic" f="e3b8a291"><F e="anthropic" f="e3b8a291">2–3%</F></F>';
    const result = fixDoubleNestedFTags(content);
    expect(result).toBe('<F e="anthropic" f="e3b8a291">2–3%</F>');
  });

  it('preserves correctly nested different <F> tags', () => {
    const content = 'Before <F e="anthropic" f="5b0663a0">\\$30B</F> and <F e="anthropic" f="6796e194">\\$380B</F> after.';
    const result = fixDoubleNestedFTags(content);
    expect(result).toBe(content); // No change
  });
});

describe('fixStrayBackslashBeforeFTag', () => {
  it('removes backslash before <F> tags', () => {
    const content = '\\<F e="anthropic" f="a8c71e05">\\$27–76B</F>';
    const result = fixStrayBackslashBeforeFTag(content);
    expect(result).toBe('<F e="anthropic" f="a8c71e05">\\$27–76B</F>');
  });

  it('preserves backslash-dollar inside <F> tags', () => {
    const content = '<F e="anthropic" f="5b0663a0">\\$30B</F>';
    const result = fixStrayBackslashBeforeFTag(content);
    expect(result).toBe(content); // No change — \\$ inside F is fine
  });
});
