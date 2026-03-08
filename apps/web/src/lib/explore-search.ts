/**
 * Client-side search scoring for the explore page fallback mode.
 *
 * Mirrors the server-side titleMatchBoostExpr logic from search-utils.ts
 * so that exact title matches rank above partial matches even when the
 * wiki-server is unavailable.
 */

import type { ExploreItem } from "@/data";

/**
 * Score how well an item matches a search query.
 * Higher scores = better match.
 *
 * Scoring tiers (matching server-side titleMatchBoostExpr):
 *   1000 - exact title match (case-insensitive)
 *    100 - title starts with query
 *     10 - query appears at a word boundary in title
 *      2 - query found in tags (exact tag match)
 *      1 - query found in description, id, or partial tag match
 *      0 - no match
 */
export function scoreSearchMatch(item: ExploreItem, query: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;

  const titleLower = item.title.toLowerCase();

  // Exact title match
  if (titleLower === q) return 1000;

  // Title starts with query + space (e.g., "Anthropic " in "Anthropic IPO")
  if (titleLower.startsWith(q + " ")) return 100;

  // Title starts with query (prefix, no space — e.g., "Anthro" matching "Anthropic")
  if (titleLower.startsWith(q)) return 90;

  // Query appears at a word boundary in title
  if (titleLower.includes(" " + q)) return 10;

  // Query in title (substring)
  if (titleLower.includes(q)) return 5;

  // Exact tag match
  if (item.tags.some((t) => t.toLowerCase() === q)) return 2;

  // Partial tag match, id, or description match
  if (
    item.id.toLowerCase().includes(q) ||
    item.description?.toLowerCase().includes(q) ||
    item.tags.some((t) => t.toLowerCase().includes(q))
  ) {
    return 1;
  }

  return 0;
}

/**
 * Filter and rank items by search query.
 * Returns items that match the query, sorted by match quality descending.
 * Items with the same match score are left in their original order
 * (which is typically recommendedScore descending).
 */
export function filterAndRankBySearch(
  items: ExploreItem[],
  query: string,
): ExploreItem[] {
  if (!query.trim()) return items;

  const scored = items
    .map((item) => ({ item, score: scoreSearchMatch(item, query) }))
    .filter(({ score }) => score > 0);

  // Stable sort: items with the same score keep their original order
  scored.sort((a, b) => b.score - a.score);

  return scored.map(({ item }) => item);
}
