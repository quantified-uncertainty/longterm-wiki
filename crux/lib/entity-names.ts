/**
 * Canonical entity display names map.
 *
 * Maps entity IDs to their human-readable display names (used for fuzzy
 * matching when scanning page content for entity mentions).
 *
 * Single source of truth — imported by fact-lookup.ts, calc-derive.ts,
 * and any future code that needs entity ID → display name resolution.
 */

export const entityDisplayNames: Record<string, string[]> = {
  anthropic: ['Anthropic'],
  openai: ['OpenAI'],
  'sam-altman': ['Sam Altman', 'Altman'],
  'jaan-tallinn': ['Jaan Tallinn', 'Tallinn'],
  worldcoin: ['Worldcoin'],
};
