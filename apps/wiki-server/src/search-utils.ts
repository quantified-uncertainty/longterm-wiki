/**
 * Shared search utilities for wiki-server routes.
 */

/**
 * Build a prefix-aware tsquery from user input.
 * Each word becomes `word:*` so partial words match (search-as-you-type).
 * Words are ANDed together like plainto_tsquery.
 *
 * Example: "AI align" → "AI:* & align:*"
 *
 * Special characters are stripped to prevent tsquery syntax errors.
 * Returns empty string if input has no valid words.
 */
export function buildPrefixTsquery(q: string): string {
  const words = q
    .trim()
    .replace(/[^a-zA-Z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "";
  return words.map((w) => `${w}:*`).join(" & ");
}

/** Minimum pg_trgm similarity score to include in trigram fallback results. */
export const TRIGRAM_SIMILARITY_THRESHOLD = 0.15;

/** Number of FTS results below which trigram fallback is triggered. */
export const TRIGRAM_FALLBACK_THRESHOLD = 3;

/** ts_headline() options for search snippet generation. */
export const TS_HEADLINE_OPTIONS =
  "StartSel=<mark>, StopSel=</mark>, MaxWords=40, MinWords=20, MaxFragments=1";
