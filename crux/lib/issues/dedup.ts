/**
 * Duplicate issue detection using Jaccard similarity on titles.
 */

import type { RankedIssue } from './types.ts';

const DEDUP_THRESHOLD = 0.55;

// Stopwords to exclude from comparison
const DEDUP_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'is', 'are',
  'add', 'fix', 'update', 'all', 'with', 'from', 'new', '--', '—', '-',
]);

function tokenize(title: string): Set<string> {
  return new Set(
    title.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2 && !DEDUP_STOPWORDS.has(w))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const intersection = new Set([...a].filter(x => b.has(x)));
  const union = new Set([...a, ...b]);
  return intersection.size / union.size;
}

/**
 * Find issue pairs with similar titles using word overlap (Jaccard similarity).
 */
export function findPotentialDuplicates(issues: RankedIssue[]): Array<{ a: RankedIssue; b: RankedIssue; similarity: number }> {
  const results: Array<{ a: RankedIssue; b: RankedIssue; similarity: number }> = [];

  const tokenized = issues.map(i => ({ issue: i, tokens: tokenize(i.title) }));

  for (let i = 0; i < tokenized.length; i++) {
    for (let j = i + 1; j < tokenized.length; j++) {
      const sim = jaccard(tokenized[i].tokens, tokenized[j].tokens);
      if (sim >= DEDUP_THRESHOLD) {
        results.push({
          a: tokenized[i].issue,
          b: tokenized[j].issue,
          similarity: sim,
        });
      }
    }
  }

  return results.sort((a, b) => b.similarity - a.similarity);
}
