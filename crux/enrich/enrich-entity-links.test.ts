/**
 * Unit tests for EntityLink enrichment tool.
 *
 * Tests cover:
 * - applyEntityLinkReplacements: core replacement logic (no LLM needed)
 * - Idempotency: running twice doesn't double-link
 * - Skip ranges: code blocks, frontmatter, existing EntityLinks
 * - First-mention-only linking
 */

import { describe, it, expect } from 'vitest';
import { applyEntityLinkReplacements, type EntityLinkReplacement } from './enrich-entity-links.ts';

describe('applyEntityLinkReplacements', () => {
  it('inserts EntityLink for a simple mention', () => {
    const content = 'Anthropic is a leading AI safety company.';
    const replacements: EntityLinkReplacement[] = [
      { searchText: 'Anthropic', entityId: 'E22', displayName: 'Anthropic' },
    ];

    const { content: result, applied } = applyEntityLinkReplacements(content, replacements);

    expect(applied).toBe(1);
    expect(result).toContain('<EntityLink id="E22">Anthropic</EntityLink>');
    expect(result).not.toContain('Anthropic is');
  });

  it('is idempotent: does not double-link already linked text', () => {
    const content = '<EntityLink id="E22">Anthropic</EntityLink> is a company. Later, Anthropic launched Claude.';
    const replacements: EntityLinkReplacement[] = [
      { searchText: 'Anthropic', entityId: 'E22', displayName: 'Anthropic' },
    ];

    const { content: result, applied } = applyEntityLinkReplacements(content, replacements);

    // The original EntityLink should still be present, but the first bare occurrence
    // outside EntityLink should be linked. However, since the first occurrence of
    // "Anthropic" in the string is inside the EntityLink, the second one may be linked.
    // The replacement engine finds the first "Anthropic" in result string, which lands
    // inside the EntityLink tag. Since it's in a skip range, it skips.
    // The "Anthropic" in "Later, Anthropic" is outside the skip range and gets linked.
    expect(result).toContain('<EntityLink id="E22">Anthropic</EntityLink> is a company');
    // Count occurrences of EntityLink opening tags
    const matches = [...result.matchAll(/<EntityLink/g)];
    // Should have at most 2 (original + the second occurrence)
    expect(matches.length).toBeLessThanOrEqual(2);
  });

  it('skips text inside code blocks', () => {
    const content = '```\nAnthropicClient.create()\n```\n\nAnthropics main company.';
    const replacements: EntityLinkReplacement[] = [
      { searchText: 'Anthropic', entityId: 'E22', displayName: 'Anthropic' },
    ];

    const { content: result } = applyEntityLinkReplacements(content, replacements);

    // The occurrence inside code block should not be linked
    expect(result).toContain('```\nAnthropicClient.create()\n```');
    // The bare occurrence outside code should be linked if it appears
    // Note: 'Anthropics' with 's' won't be found if we search for 'Anthropic' exactly
  });

  it('skips text inside inline code', () => {
    const content = 'Use `Anthropic` in your code. Anthropic is the company.';
    const replacements: EntityLinkReplacement[] = [
      { searchText: 'Anthropic', entityId: 'E22', displayName: 'Anthropic' },
    ];

    const { content: result } = applyEntityLinkReplacements(content, replacements);

    // The occurrence inside inline code should be skipped
    expect(result).toContain('`Anthropic`');
  });

  it('skips frontmatter content', () => {
    const content = `---
title: "Anthropic Overview"
id: anthropic
---

Anthropic is a company.`;
    const replacements: EntityLinkReplacement[] = [
      { searchText: 'Anthropic', entityId: 'E22', displayName: 'Anthropic' },
    ];

    const { content: result } = applyEntityLinkReplacements(content, replacements);

    // Frontmatter title should NOT be linked
    expect(result).toContain('title: "Anthropic Overview"');
    // Body occurrence should be linked
    expect(result).toContain('<EntityLink id="E22">Anthropic</EntityLink> is a company');
  });

  it('applies multiple different entity replacements', () => {
    const content = 'Anthropic and OpenAI are both AI safety companies.';
    const replacements: EntityLinkReplacement[] = [
      { searchText: 'Anthropic', entityId: 'E22', displayName: 'Anthropic' },
      { searchText: 'OpenAI', entityId: 'E10', displayName: 'OpenAI' },
    ];

    const { content: result, applied } = applyEntityLinkReplacements(content, replacements);

    expect(applied).toBe(2);
    expect(result).toContain('<EntityLink id="E22">Anthropic</EntityLink>');
    expect(result).toContain('<EntityLink id="E10">OpenAI</EntityLink>');
  });

  it('returns 0 applied when searchText not found', () => {
    const content = 'DeepMind is doing great work.';
    const replacements: EntityLinkReplacement[] = [
      { searchText: 'Anthropic', entityId: 'E22', displayName: 'Anthropic' },
    ];

    const { content: result, applied } = applyEntityLinkReplacements(content, replacements);

    expect(applied).toBe(0);
    expect(result).toBe(content);
  });

  it('skips text inside existing EntityLink tags (full tag)', () => {
    const content = 'See <EntityLink id="E22">Anthropic</EntityLink> for details.';
    const replacements: EntityLinkReplacement[] = [
      { searchText: 'Anthropic', entityId: 'E22', displayName: 'Anthropic' },
    ];

    const { content: result, applied } = applyEntityLinkReplacements(content, replacements);

    // "Anthropic" is inside the EntityLink, so it should be in a skip range
    // The result should have exactly one EntityLink
    const matches = [...result.matchAll(/<EntityLink/g)];
    expect(matches.length).toBe(1);
    // Applied should be 0 since the only occurrence is in a skip range
    expect(applied).toBe(0);
  });

  it('handles content with no matches gracefully', () => {
    const content = 'This content has no entity mentions.';
    const replacements: EntityLinkReplacement[] = [];

    const { content: result, applied } = applyEntityLinkReplacements(content, replacements);

    expect(applied).toBe(0);
    expect(result).toBe(content);
  });

  it('preserves surrounding text correctly', () => {
    const content = 'Founded by Dario Amodei, Anthropic has grown rapidly.';
    const replacements: EntityLinkReplacement[] = [
      { searchText: 'Anthropic', entityId: 'E22', displayName: 'Anthropic' },
    ];

    const { content: result } = applyEntityLinkReplacements(content, replacements);

    expect(result).toBe('Founded by Dario Amodei, <EntityLink id="E22">Anthropic</EntityLink> has grown rapidly.');
  });

  it('only links the first valid occurrence (first-mention convention)', () => {
    const content = 'Anthropic was founded in 2021. Since then, Anthropic has grown. Today Anthropic employs hundreds.';
    const replacements: EntityLinkReplacement[] = [
      { searchText: 'Anthropic', entityId: 'E22', displayName: 'Anthropic' },
    ];

    const { content: result, applied } = applyEntityLinkReplacements(content, replacements);

    // Only the first occurrence should be linked
    expect(applied).toBe(1);
    const matches = [...result.matchAll(/<EntityLink/g)];
    expect(matches.length).toBe(1);
    // The first "Anthropic" should be linked
    expect(result.startsWith('<EntityLink id="E22">Anthropic</EntityLink>')).toBe(true);
  });

  it('skips entity name inside markdown link display text', () => {
    const content = 'Visit [Anthropic](https://anthropic.com) for more info.';
    const replacements: EntityLinkReplacement[] = [
      { searchText: 'Anthropic', entityId: 'E22', displayName: 'Anthropic' },
    ];

    const { content: result, applied } = applyEntityLinkReplacements(content, replacements);

    // "Anthropic" inside [Anthropic](...) must not be enriched — it would break MDX link syntax
    expect(applied).toBe(0);
    expect(result).toBe(content);
  });

  it('skips entity name inside markdown link URL', () => {
    const content = 'Research at [link](https://example.com/Anthropic/papers).';
    const replacements: EntityLinkReplacement[] = [
      { searchText: 'Anthropic', entityId: 'E22', displayName: 'Anthropic' },
    ];

    const { content: result, applied } = applyEntityLinkReplacements(content, replacements);

    expect(applied).toBe(0);
    expect(result).toBe(content);
  });

  it('enriches entity name outside markdown link but not inside', () => {
    const content = 'Anthropic offers research at [their site](https://anthropic.com).';
    const replacements: EntityLinkReplacement[] = [
      { searchText: 'Anthropic', entityId: 'E22', displayName: 'Anthropic' },
    ];

    const { content: result, applied } = applyEntityLinkReplacements(content, replacements);

    // The bare "Anthropic" at the start should be linked
    expect(applied).toBe(1);
    expect(result).toContain('<EntityLink id="E22">Anthropic</EntityLink>');
    // The markdown link should be untouched
    expect(result).toContain('[their site](https://anthropic.com)');
    // Must not produce broken MDX like [<EntityLink...]
    expect(result).not.toMatch(/\[<EntityLink/);
  });

  it('links second occurrence when first occurrence is inside a markdown link', () => {
    const content = 'Visit [Anthropic](https://anthropic.com) to learn about Anthropic\'s research.';
    const replacements: EntityLinkReplacement[] = [
      { searchText: 'Anthropic', entityId: 'E22', displayName: 'Anthropic' },
    ];

    const { content: result, applied } = applyEntityLinkReplacements(content, replacements);

    // First mention is inside the link (skip range), second bare mention should be linked
    expect(applied).toBe(1);
    expect(result).toContain('[Anthropic](https://anthropic.com)');
    expect(result).toContain('<EntityLink id="E22">Anthropic</EntityLink>');
    expect(result).not.toMatch(/\[<EntityLink/);
  });

  it('skips entity name inside markdown link with parentheses in URL', () => {
    const content = 'See [Wikipedia](https://en.wikipedia.org/wiki/Anthropic_(company)) for more.';
    const replacements: EntityLinkReplacement[] = [
      { searchText: 'Anthropic', entityId: 'E22', displayName: 'Anthropic' },
    ];

    const { content: result, applied } = applyEntityLinkReplacements(content, replacements);

    // "Anthropic" in the URL (inside nested parens) should not be enriched
    expect(applied).toBe(0);
    expect(result).toBe(content);
  });

  it('returns only applied replacements (not unapplied LLM proposals)', () => {
    // "DeepMind" is not in the content, so it should not appear in appliedReplacements
    const content = 'Anthropic is an AI safety company.';
    const replacements: EntityLinkReplacement[] = [
      { searchText: 'Anthropic', entityId: 'E22', displayName: 'Anthropic' },
      { searchText: 'DeepMind', entityId: 'E99', displayName: 'DeepMind' },
    ];

    const { applied, appliedReplacements } = applyEntityLinkReplacements(content, replacements);

    expect(applied).toBe(1);
    expect(appliedReplacements).toHaveLength(1);
    expect(appliedReplacements[0].entityId).toBe('E22');
  });

  it('skips text inside markdown links (#672)', () => {
    const content = 'Read [Anthropic Safety](https://anthropic.com/safety) for details. Anthropic is great.';
    const replacements: EntityLinkReplacement[] = [
      { searchText: 'Anthropic', entityId: 'E22', displayName: 'Anthropic' },
    ];

    const { content: result, applied } = applyEntityLinkReplacements(content, replacements);

    // The "Anthropic" inside [Anthropic Safety](url) should NOT be linked
    expect(result).toContain('[Anthropic Safety](https://anthropic.com/safety)');
    // But the bare "Anthropic" outside the link should be linked
    expect(applied).toBe(1);
    expect(result).toContain('<EntityLink id="E22">Anthropic</EntityLink> is great');
  });

  it('skips entity name inside reference-style markdown link [text][ref] (#687)', () => {
    const content = 'See [Anthropic][1] for more details.\n\n[1]: https://anthropic.com';
    const replacements: EntityLinkReplacement[] = [
      { searchText: 'Anthropic', entityId: 'E22', displayName: 'Anthropic' },
    ];

    const { content: result, applied } = applyEntityLinkReplacements(content, replacements);

    // "Anthropic" inside [Anthropic][1] must not be enriched
    expect(applied).toBe(0);
    expect(result).toBe(content);
  });

  it('skips numbers in reference-style link definition lines (#687)', () => {
    const content = 'Anthropic is great.\n\n[1]: https://anthropic.com/research/2024';
    const replacements: EntityLinkReplacement[] = [
      { searchText: '2024', entityId: 'E99', displayName: '2024' },
    ];

    const { content: result, applied } = applyEntityLinkReplacements(content, replacements);

    // "2024" inside the reference definition line must not be enriched
    expect(applied).toBe(0);
    expect(result).toBe(content);
  });

  it('enriches entity outside ref-style link but not inside (#687)', () => {
    const content = 'Anthropic is a company. See [Anthropic site][1].\n\n[1]: https://anthropic.com';
    const replacements: EntityLinkReplacement[] = [
      { searchText: 'Anthropic', entityId: 'E22', displayName: 'Anthropic' },
    ];

    const { content: result, applied } = applyEntityLinkReplacements(content, replacements);

    // The bare "Anthropic" at the start should be linked
    expect(applied).toBe(1);
    expect(result).toContain('<EntityLink id="E22">Anthropic</EntityLink> is a company');
    // The ref-style link should be untouched
    expect(result).toContain('[Anthropic site][1]');
  });

  it('skips text inside MDX comments (#681)', () => {
    const content = '{/* TODO: add Anthropic details */}\n\nAnthropics main AI safety company.';
    const replacements: EntityLinkReplacement[] = [
      { searchText: 'Anthropic', entityId: 'E22', displayName: 'Anthropic' },
    ];

    const { content: result } = applyEntityLinkReplacements(content, replacements);

    // The "Anthropic" inside the MDX comment should NOT be linked
    expect(result).toContain('{/* TODO: add Anthropic details */}');
  });

  it('does not nest EntityLinks when a later replacement matches inside an earlier one', () => {
    // "Machine Intelligence Research Institute" is linked first, then "Intelligence"
    // should NOT match inside the new <EntityLink> display text
    const content = 'The Machine Intelligence Research Institute (MIRI) studies Intelligence safety.';
    const replacements: EntityLinkReplacement[] = [
      { searchText: 'Machine Intelligence Research Institute', entityId: 'E40', displayName: 'Machine Intelligence Research Institute' },
      { searchText: 'Intelligence', entityId: 'E41', displayName: 'Intelligence' },
    ];

    const { content: result, applied } = applyEntityLinkReplacements(content, replacements);

    expect(applied).toBe(2);
    // First replacement: the full institute name is linked
    expect(result).toContain('<EntityLink id="E40">Machine Intelligence Research Institute</EntityLink>');
    // Second replacement: "Intelligence" in "Intelligence safety" is linked (not the one inside E40)
    expect(result).toContain('<EntityLink id="E41">Intelligence</EntityLink> safety');
    // MUST NOT have nested EntityLinks (EntityLink inside another's display text)
    expect(result).not.toMatch(/<EntityLink[^>]*>[^<]*<EntityLink/);
  });

  it('does not link substring matches inside previously created EntityLinks', () => {
    // "OpenPhilanthropy" linked first, then "Phil" should not match inside it
    const content = 'OpenPhilanthropy funds AI safety. Phil also contributes.';
    const replacements: EntityLinkReplacement[] = [
      { searchText: 'OpenPhilanthropy', entityId: 'E50', displayName: 'OpenPhilanthropy' },
      { searchText: 'Phil', entityId: 'E51', displayName: 'Phil' },
    ];

    const { content: result, applied } = applyEntityLinkReplacements(content, replacements);

    expect(applied).toBe(2);
    // "Phil" should link the standalone occurrence, not inside OpenPhilanthropy
    expect(result).toContain('<EntityLink id="E51">Phil</EntityLink> also');
    expect(result).not.toMatch(/<EntityLink id="E50">Open<EntityLink/);
  });
});
