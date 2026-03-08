/**
 * Canonical entity display names map.
 *
 * Maps entity IDs to their human-readable display names (used for fuzzy
 * matching when scanning page content for entity mentions).
 *
 * Shared alias map for entity mention scanning. Not exhaustive — fall
 * back to KB data for authoritative names.
 */

export const entityDisplayNames: Record<string, string[]> = {
  anthropic: ['Anthropic'],
  openai: ['OpenAI'],
  'sam-altman': ['Sam Altman', 'Altman'],
  'jaan-tallinn': ['Jaan Tallinn', 'Tallinn'],
  worldcoin: ['Worldcoin'],
};
