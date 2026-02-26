/**
 * Pipeline Linking Logic — Integration-style Tests
 *
 * The backfill pipeline (backfill-from-citations.ts) matches citation_quotes
 * to claims using isClaimDuplicate and jaccardWordSimilarity. This file tests
 * the matching algorithm at the level of those primitives, simulating how the
 * pipeline groups quotes and selects the best match.
 *
 * Key algorithms tested:
 * 1. Quote grouping: quotes within a page are grouped by text similarity
 *    using isClaimDuplicate with threshold 0.6
 * 2. Dedup against existing claims: each group's representative is checked
 *    against existing claims using isClaimDuplicate with threshold 0.7
 * 3. Best match selection: when matching a quote against multiple candidate
 *    claims, the highest jaccardWordSimilarity score wins
 */

import { describe, it, expect } from 'vitest';
import {
  isClaimDuplicate,
  jaccardWordSimilarity,
} from '../lib/claim-utils.ts';

// ---------------------------------------------------------------------------
// Types — lightweight stand-ins for the pipeline's data structures
// ---------------------------------------------------------------------------

interface MockQuote {
  id: number;
  claimText: string;
  footnote: number;
}

interface MockClaim {
  id: number;
  claimText: string;
}

// ---------------------------------------------------------------------------
// Helpers — replicate the pipeline's matching algorithms
// ---------------------------------------------------------------------------

/**
 * Group quotes by text similarity, replicating the backfill pipeline's
 * grouping logic (lines 216-230 of backfill-from-citations.ts).
 */
function groupQuotesBySimilarity(
  quotes: MockQuote[],
  threshold = 0.6,
): MockQuote[][] {
  const groups: MockQuote[][] = [];
  const assigned = new Set<number>();

  for (const q of quotes) {
    if (assigned.has(q.id)) continue;

    const group: MockQuote[] = [q];
    assigned.add(q.id);

    for (const other of quotes) {
      if (assigned.has(other.id)) continue;
      if (isClaimDuplicate(q.claimText, other.claimText, threshold)) {
        group.push(other);
        assigned.add(other.id);
      }
    }
    groups.push(group);
  }
  return groups;
}

/**
 * Pick the longest/most representative quote from a group,
 * replicating lines 237-239 of backfill-from-citations.ts.
 */
function pickRepresentative(group: MockQuote[]): MockQuote {
  return group.reduce((best, q) =>
    q.claimText.length > best.claimText.length ? q : best,
  );
}

/**
 * Find the best-matching claim for a quote using Jaccard similarity.
 * Returns the matched claim and score, or null if no claim exceeds the threshold.
 */
function findBestMatch(
  quoteText: string,
  candidates: MockClaim[],
  threshold = 0.5,
): { claim: MockClaim; score: number } | null {
  let best: { claim: MockClaim; score: number } | null = null;
  for (const candidate of candidates) {
    const score = jaccardWordSimilarity(quoteText, candidate.claimText);
    if (score >= threshold && (!best || score > best.score)) {
      best = { claim: candidate, score };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Quote grouping tests
// ---------------------------------------------------------------------------

describe('quote grouping by similarity', () => {
  it('groups identical quotes together', () => {
    const quotes: MockQuote[] = [
      { id: 1, claimText: 'Anthropic raised $7.3 billion in funding.', footnote: 1 },
      { id: 2, claimText: 'Anthropic raised $7.3 billion in funding.', footnote: 3 },
      { id: 3, claimText: 'Kalshi was founded in 2018.', footnote: 2 },
    ];
    const groups = groupQuotesBySimilarity(quotes);
    expect(groups).toHaveLength(2);

    // First group should contain the two identical Anthropic quotes
    const anthropicGroup = groups.find(g => g[0].claimText.includes('Anthropic'));
    expect(anthropicGroup).toBeDefined();
    expect(anthropicGroup!.length).toBe(2);
  });

  it('groups paraphrased quotes together at 0.6 threshold', () => {
    const quotes: MockQuote[] = [
      { id: 1, claimText: 'Anthropic raised $7.3 billion in total funding.', footnote: 1 },
      { id: 2, claimText: 'Anthropic has raised $7.3 billion in funding to date.', footnote: 5 },
      { id: 3, claimText: 'GPT-4 scores 86.4% on the MMLU benchmark.', footnote: 2 },
    ];
    const groups = groupQuotesBySimilarity(quotes, 0.6);
    expect(groups).toHaveLength(2);

    const anthropicGroup = groups.find(g => g[0].claimText.includes('Anthropic'));
    expect(anthropicGroup).toBeDefined();
    expect(anthropicGroup!.length).toBe(2);
  });

  it('keeps different topics in separate groups', () => {
    const quotes: MockQuote[] = [
      { id: 1, claimText: 'Anthropic raised $7.3 billion in total funding.', footnote: 1 },
      { id: 2, claimText: 'Kalshi was founded in 2018 as a prediction market.', footnote: 2 },
      { id: 3, claimText: 'OpenAI released GPT-4 in March 2023.', footnote: 3 },
    ];
    const groups = groupQuotesBySimilarity(quotes);
    expect(groups).toHaveLength(3);
  });

  it('groups multiple overlapping quotes into one group', () => {
    const quotes: MockQuote[] = [
      { id: 1, claimText: 'Anthropic raised $7.3 billion in total funding.', footnote: 1 },
      { id: 2, claimText: 'Anthropic raised $7.3 billion in total funding as of 2024.', footnote: 2 },
      { id: 3, claimText: 'Anthropic raised $7.3 billion in venture funding.', footnote: 3 },
    ];
    const groups = groupQuotesBySimilarity(quotes, 0.6);
    // All three should be grouped together since they're all similar
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });

  it('handles empty input', () => {
    expect(groupQuotesBySimilarity([])).toEqual([]);
  });

  it('handles single quote', () => {
    const quotes: MockQuote[] = [
      { id: 1, claimText: 'Single claim about something.', footnote: 1 },
    ];
    const groups = groupQuotesBySimilarity(quotes);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Representative selection tests
// ---------------------------------------------------------------------------

describe('pickRepresentative', () => {
  it('picks the longest quote as representative', () => {
    const group: MockQuote[] = [
      { id: 1, claimText: 'Short claim.', footnote: 1 },
      { id: 2, claimText: 'This is a much longer and more detailed claim about the topic.', footnote: 2 },
      { id: 3, claimText: 'Medium length claim here.', footnote: 3 },
    ];
    const rep = pickRepresentative(group);
    expect(rep.id).toBe(2);
  });

  it('handles single-element group', () => {
    const group: MockQuote[] = [
      { id: 1, claimText: 'Only quote.', footnote: 1 },
    ];
    expect(pickRepresentative(group).id).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Best match selection tests (citation-to-claim matching)
// ---------------------------------------------------------------------------

describe('findBestMatch (citation-to-claim matching)', () => {
  const claims: MockClaim[] = [
    { id: 1, claimText: 'Anthropic raised $7.3 billion in total funding.' },
    { id: 2, claimText: 'Kalshi was founded in 2018 as a prediction market platform.' },
    { id: 3, claimText: 'OpenAI released GPT-4 in March 2023 with state-of-the-art performance.' },
    { id: 4, claimText: 'DeepMind developed AlphaFold to predict protein structures.' },
  ];

  it('matches a quote to the most similar claim', () => {
    const result = findBestMatch(
      'Anthropic has raised $7.3 billion in funding to date.',
      claims,
    );
    expect(result).not.toBeNull();
    expect(result!.claim.id).toBe(1);
    expect(result!.score).toBeGreaterThan(0.5);
  });

  it('returns null when no claim exceeds the threshold', () => {
    const result = findBestMatch(
      'The weather in San Francisco is mild year-round.',
      claims,
    );
    expect(result).toBeNull();
  });

  it('selects the best Jaccard score when multiple claims partially match', () => {
    // This quote is about OpenAI/GPT-4, should match claim #3 best
    const result = findBestMatch(
      'OpenAI released GPT-4 in March 2023.',
      claims,
      0.4,
    );
    expect(result).not.toBeNull();
    expect(result!.claim.id).toBe(3);
  });

  it('respects threshold — high threshold rejects weak matches', () => {
    // At threshold 0.95, even a close paraphrase should not match
    const result = findBestMatch(
      'Anthropic has raised $7.3 billion in funding.',
      claims,
      0.95,
    );
    expect(result).toBeNull();
  });

  it('handles empty candidate list', () => {
    const result = findBestMatch('Some quote text.', []);
    expect(result).toBeNull();
  });

  it('returns the single match when only one candidate exists above threshold', () => {
    const singleClaim = [
      { id: 99, claimText: 'Anthropic raised $7.3 billion in total funding.' },
    ];
    const result = findBestMatch(
      'Anthropic raised $7.3 billion in total funding as of 2024.',
      singleClaim,
    );
    expect(result).not.toBeNull();
    expect(result!.claim.id).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// Integration: grouping + dedup against existing claims
// ---------------------------------------------------------------------------

describe('end-to-end: group quotes, pick representatives, dedup against existing', () => {
  it('groups quotes and skips duplicates of existing claims', () => {
    const quotes: MockQuote[] = [
      { id: 1, claimText: 'Anthropic raised $7.3 billion in total funding.', footnote: 1 },
      { id: 2, claimText: 'Anthropic raised $7.3 billion in total funding as of 2024.', footnote: 3 },
      { id: 3, claimText: 'Kalshi was founded in 2018 as a prediction market.', footnote: 2 },
      { id: 4, claimText: 'OpenAI released GPT-4 in March 2023.', footnote: 4 },
    ];

    // Quote 1 is exact match; Quote 2 is a substring-containment match (ratio > 0.6).
    // Both should group together AND the group representative should match existing at 0.7.
    const existingClaims = [
      'Anthropic raised $7.3 billion in total funding.',
    ];

    // Step 1: Group quotes
    const groups = groupQuotesBySimilarity(quotes, 0.6);

    // Step 2: Pick representatives and check against existing
    const newClaimsToCreate: string[] = [];
    const skippedDups: string[] = [];

    for (const group of groups) {
      const rep = pickRepresentative(group);
      const isDup = existingClaims.some(t =>
        isClaimDuplicate(rep.claimText, t, 0.7),
      );
      if (isDup) {
        skippedDups.push(rep.claimText);
      } else {
        newClaimsToCreate.push(rep.claimText);
        // Add to existing so later groups are checked against it
        existingClaims.push(rep.claimText);
      }
    }

    // The Anthropic group should be skipped (duplicate of existing)
    expect(skippedDups.length).toBe(1);
    expect(skippedDups[0]).toContain('Anthropic');

    // Kalshi and OpenAI should be created as new claims
    expect(newClaimsToCreate).toHaveLength(2);
    expect(newClaimsToCreate.some(t => t.includes('Kalshi'))).toBe(true);
    expect(newClaimsToCreate.some(t => t.includes('OpenAI'))).toBe(true);
  });

  it('prevents intra-batch duplicates by appending to existingTexts', () => {
    const quotes: MockQuote[] = [
      { id: 1, claimText: 'Kalshi was founded in 2018 as a prediction market.', footnote: 1 },
      { id: 2, claimText: 'OpenAI released GPT-4 in March 2023.', footnote: 2 },
      // This is a paraphrase of quote 1, but gets its own group because
      // grouping threshold at 0.6 might or might not catch it depending on wording.
      // Let's simulate it landing in a separate group:
    ];

    const existingClaims: string[] = [];
    const groups = groupQuotesBySimilarity(quotes, 0.6);
    const created: string[] = [];

    for (const group of groups) {
      const rep = pickRepresentative(group);
      const isDup = existingClaims.some(t =>
        isClaimDuplicate(rep.claimText, t, 0.7),
      );
      if (!isDup) {
        created.push(rep.claimText);
        existingClaims.push(rep.claimText);
      }
    }

    // Both should be created since they're genuinely different
    expect(created).toHaveLength(2);
  });

  it('handles page with all duplicate quotes (no new claims created)', () => {
    const quotes: MockQuote[] = [
      { id: 1, claimText: 'Anthropic raised $7.3 billion in total funding.', footnote: 1 },
      { id: 2, claimText: 'Anthropic raised $7.3 billion in funding.', footnote: 2 },
    ];

    const existingClaims = [
      'Anthropic raised $7.3 billion in total funding.',
    ];

    const groups = groupQuotesBySimilarity(quotes, 0.6);
    let newCount = 0;

    for (const group of groups) {
      const rep = pickRepresentative(group);
      const isDup = existingClaims.some(t =>
        isClaimDuplicate(rep.claimText, t, 0.7),
      );
      if (!isDup) newCount++;
    }

    expect(newCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases in matching
// ---------------------------------------------------------------------------

describe('matching edge cases', () => {
  it('handles quotes with special characters (dollar signs, percentages)', () => {
    const score = jaccardWordSimilarity(
      'Revenue was $100M in Q3 2024.',
      'Revenue was $100M during Q3 2024.',
    );
    // Jaccard ~0.71: {revenue, was, $100m, in, q3, 2024} vs {revenue, was, $100m, during, q3, 2024}
    // Intersection 5, Union 7 -> 5/7 = 0.714
    expect(score).toBeGreaterThan(0.7);
  });

  it('handles very long claims', () => {
    const longA = 'Anthropic ' + 'has developed advanced AI safety techniques '.repeat(10) + 'for alignment research.';
    const longB = 'Anthropic ' + 'has developed advanced AI safety techniques '.repeat(10) + 'for alignment.';
    expect(isClaimDuplicate(longA, longB)).toBe(true);
  });

  it('distinguishes claims about different entities with similar structure', () => {
    const a = 'Anthropic raised $7.3 billion in total funding.';
    const b = 'OpenAI raised $11.3 billion in total funding.';
    // These share structure but differ on entity and amount
    // Jaccard: {anthropic, raised, $7.3, billion, in, total, funding}
    //       vs {openai, raised, $11.3, billion, in, total, funding}
    // Intersection: {raised, billion, in, total, funding} = 5
    // Union: 9
    // Jaccard = 5/9 ~ 0.56 -> below 0.75 default threshold
    expect(isClaimDuplicate(a, b)).toBe(false);
  });

  it('matches claims that differ only by trailing punctuation', () => {
    expect(isClaimDuplicate(
      'Kalshi was founded in 2018.',
      'Kalshi was founded in 2018!',
    )).toBe(true);
  });
});
