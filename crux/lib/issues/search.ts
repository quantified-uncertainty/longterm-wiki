/**
 * Issue search: tokenization, stemming, and query-weighted scoring.
 *
 * Used by the `search` command for keyword-based issue dedup checking.
 */

// Only truly semantic-free words. Domain-relevant verbs (add, fix, remove) are kept
// because "add entity" and "remove entity" mean opposite things.
const SEARCH_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'is', 'are',
  'all', 'with', 'from', '--', '—', '-',
  'this', 'that', 'not', 'but', 'has', 'have', 'should', 'would', 'could',
  'when', 'where', 'how', 'what', 'why', 'does', 'been', 'being',
]);

// Short domain terms that should NOT be filtered by length
const SHORT_TERMS = new Set(['ci', 'dx', 'pr', 'id', 'ui', 'db', 'api', 'css', 'rpc', 'mdx', 'tsx', 'sql']);

/** Crude suffix stemming — good enough for dedup, no dependencies needed. */
export function stem(word: string): string {
  if (word.length <= 4) return word;
  // Order matters: longest suffixes first
  return word
    .replace(/ations?$/, 'ate')
    .replace(/tion$/, 't')
    .replace(/sion$/, 's')
    .replace(/ment$/, '')
    .replace(/ness$/, '')
    .replace(/ies$/, 'y')
    .replace(/ous$/, '')
    .replace(/ing$/, '')
    .replace(/able$/, '')
    .replace(/ive$/, '')
    .replace(/ful$/, '')
    .replace(/ers?$/, '')
    .replace(/ors?$/, '')
    .replace(/ed$/, '')
    .replace(/ly$/, '')
    .replace(/s$/, '');
}

export function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .split(/\s+/)
      .filter(w => (w.length > 1 && SHORT_TERMS.has(w)) || (w.length > 2 && !SEARCH_STOPWORDS.has(w)))
      .map(stem)
  );
}

/**
 * Score how well a query matches a target issue.
 *
 * Uses query-weighted overlap (what fraction of query tokens appear in target?)
 * with title matches worth 2x body matches, plus a penalty for single-token
 * queries to avoid false "100%" matches.
 */
export function scoreMatch(queryTokens: Set<string>, titleTokens: Set<string>, bodyTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0;

  let weightedMatches = 0;
  for (const token of queryTokens) {
    if (titleTokens.has(token)) {
      weightedMatches += 1.0; // title match: full weight
    } else if (bodyTokens.has(token)) {
      weightedMatches += 0.5; // body-only match: half weight
    }
  }

  let raw = weightedMatches / queryTokens.size;

  // Penalize single-token queries: they match too broadly.
  // A single token matching the title still scores 0.7 max, not 1.0.
  if (queryTokens.size === 1) {
    raw *= 0.7;
  }

  return Math.min(raw, 1.0);
}
