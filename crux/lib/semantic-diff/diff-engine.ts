/**
 * Semantic Diff Engine
 *
 * Compares two sets of extracted claims (before and after page modification)
 * and produces a structured diff of what changed.
 *
 * Uses Jaccard word-similarity (already present in claim-utils.ts) to match
 * semantically similar claims across versions, then identifies which values
 * actually changed.
 *
 * Design decisions:
 * - No LLM calls in the diff step (pure computation, fast and cheap)
 * - Uses the existing Jaccard similarity from claim-utils.ts for consistency
 * - A claim is "changed" when it matches an existing claim but has a different keyValue
 */

import { jaccardWordSimilarity } from '../claim-utils.ts';
import type {
  ExtractedClaim,
  ClaimDiffEntry,
  ClaimDiffStatus,
  SemanticDiff,
} from './types.ts';

// Threshold for two claims to be considered "the same claim with different values"
// vs "two unrelated claims". At 0.5, claims must share half their vocabulary.
const MATCH_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Internal matching
// ---------------------------------------------------------------------------

interface ClaimMatch {
  beforeIndex: number;
  afterIndex: number;
  similarity: number;
}

/**
 * Find the best matching pairs between before and after claims.
 * Uses a greedy matching algorithm: highest-similarity pairs are matched first.
 */
function findBestMatches(
  beforeClaims: ExtractedClaim[],
  afterClaims: ExtractedClaim[],
): ClaimMatch[] {
  // Build all potential matches above threshold
  const candidates: ClaimMatch[] = [];

  for (let i = 0; i < beforeClaims.length; i++) {
    for (let j = 0; j < afterClaims.length; j++) {
      const sim = jaccardWordSimilarity(beforeClaims[i].text, afterClaims[j].text);
      if (sim >= MATCH_THRESHOLD) {
        candidates.push({ beforeIndex: i, afterIndex: j, similarity: sim });
      }
    }
  }

  // Sort by similarity descending
  candidates.sort((a, b) => b.similarity - a.similarity);

  // Greedy assignment: each before/after claim can be matched at most once
  const usedBefore = new Set<number>();
  const usedAfter = new Set<number>();
  const matches: ClaimMatch[] = [];

  for (const candidate of candidates) {
    if (!usedBefore.has(candidate.beforeIndex) && !usedAfter.has(candidate.afterIndex)) {
      matches.push(candidate);
      usedBefore.add(candidate.beforeIndex);
      usedAfter.add(candidate.afterIndex);
    }
  }

  return matches;
}

/**
 * Determine what changed between two matched claims.
 * Returns a description if the claim actually changed, or undefined if unchanged.
 */
function describeChange(before: ExtractedClaim, after: ExtractedClaim): string | undefined {
  // Key value changed (most important change)
  if (before.keyValue !== undefined && after.keyValue !== undefined) {
    if (before.keyValue !== after.keyValue) {
      return `Key value changed: "${before.keyValue}" → "${after.keyValue}"`;
    }
  } else if (before.keyValue !== undefined && after.keyValue === undefined) {
    return `Key value removed: was "${before.keyValue}"`;
  } else if (before.keyValue === undefined && after.keyValue !== undefined) {
    return `Key value added: "${after.keyValue}"`;
  }

  // Text changed significantly despite high similarity
  // (e.g., "X raised $100M" → "X raised $200M" when keyValue is not set)
  const normBefore = before.text.toLowerCase().trim();
  const normAfter = after.text.toLowerCase().trim();
  if (normBefore !== normAfter) {
    // Only flag if the texts are different enough to matter
    const sim = jaccardWordSimilarity(before.text, after.text);
    if (sim < 0.95) {
      return `Claim text updated`;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a structured semantic diff between two sets of claims.
 *
 * @param beforeClaims - Claims extracted from the page before modification
 * @param afterClaims - Claims extracted from the page after modification
 * @returns A SemanticDiff with categorized entries
 */
export function diffClaims(
  beforeClaims: ExtractedClaim[],
  afterClaims: ExtractedClaim[],
): SemanticDiff {
  const matches = findBestMatches(beforeClaims, afterClaims);

  const matchedBeforeIndices = new Set(matches.map(m => m.beforeIndex));
  const matchedAfterIndices = new Set(matches.map(m => m.afterIndex));

  const entries: ClaimDiffEntry[] = [];

  // Process matched pairs
  for (const match of matches) {
    const before = beforeClaims[match.beforeIndex];
    const after = afterClaims[match.afterIndex];
    const changeDescription = describeChange(before, after);

    const status: ClaimDiffStatus = changeDescription ? 'changed' : 'unchanged';

    entries.push({
      status,
      oldClaim: before,
      newClaim: after,
      changeDescription,
    });
  }

  // Unmatched before claims = removed
  for (let i = 0; i < beforeClaims.length; i++) {
    if (!matchedBeforeIndices.has(i)) {
      entries.push({
        status: 'removed',
        oldClaim: beforeClaims[i],
      });
    }
  }

  // Unmatched after claims = added
  for (let j = 0; j < afterClaims.length; j++) {
    if (!matchedAfterIndices.has(j)) {
      entries.push({
        status: 'added',
        newClaim: afterClaims[j],
      });
    }
  }

  const summary = {
    added: entries.filter(e => e.status === 'added').length,
    removed: entries.filter(e => e.status === 'removed').length,
    changed: entries.filter(e => e.status === 'changed').length,
    unchanged: entries.filter(e => e.status === 'unchanged').length,
  };

  return {
    claimsBefore: beforeClaims.length,
    claimsAfter: afterClaims.length,
    entries,
    summary,
  };
}
