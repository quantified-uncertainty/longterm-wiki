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

/**
 * Build a SQL expression that boosts the FTS rank for exact or prefix title matches.
 * - Exact match (case-insensitive): +1000 bonus (guarantees top result)
 * - Title starts with query: +100 bonus
 * - Query found at a word boundary in title: +10 bonus
 *
 * This ensures that a page titled "Anthropic" ranks above "Anthropic IPO"
 * when the user searches for "Anthropic".
 *
 * @param titleColumn - SQL column reference for the title (e.g. "title" or "wp.title")
 * @param queryParamRef - SQL parameter reference (e.g. "$1")
 */
export function titleMatchBoostExpr(
  titleColumn: string,
  queryParamRef: string,
): string {
  // Uses starts_with() and position() instead of LIKE to avoid
  // LIKE special characters (%, _) in user input affecting results.
  return `(
    CASE
      WHEN lower(${titleColumn}) = lower(${queryParamRef}) THEN 1000
      WHEN starts_with(lower(${titleColumn}), lower(${queryParamRef}) || ' ') THEN 100
      WHEN position(' ' || lower(${queryParamRef}) in lower(${titleColumn})) > 0 THEN 10
      ELSE 0
    END
  )`;
}

/** Minimum pg_trgm similarity score to include in trigram fallback results. */
export const TRIGRAM_SIMILARITY_THRESHOLD = 0.15;

/** Number of FTS results below which trigram fallback is triggered. */
export const TRIGRAM_FALLBACK_THRESHOLD = 3;

/** ts_headline() options for search snippet generation. */
export const TS_HEADLINE_OPTIONS =
  "StartSel=<mark>, StopSel=</mark>, MaxWords=40, MinWords=20, MaxFragments=1";
