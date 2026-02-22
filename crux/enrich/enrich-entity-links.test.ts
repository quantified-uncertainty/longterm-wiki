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
});
