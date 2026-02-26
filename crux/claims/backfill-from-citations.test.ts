/**
 * Tests for claims unification / backfill-from-citations logic.
 *
 * The backfill pipeline (backfill-from-citations.ts) orchestrates API calls
 * internally, so we test the pure utility functions it depends on:
 *   - isClaimDuplicate: core dedup predicate
 *   - deduplicateClaims: batch dedup filter
 *   - jaccardWordSimilarity: word-level similarity scoring
 *   - jaccardSimilarity: set-level Jaccard
 *   - normalizeClaimText: text normalization
 *   - claimTypeToCategory: type-to-category mapping
 *
 * Covers scenarios that arise during citation backfill: grouping quotes by
 * text similarity, deduplicating against existing claims, and mapping claim
 * types to categories for newly created claims.
 */

import { describe, it, expect } from 'vitest';
import {
  isClaimDuplicate,
  deduplicateClaims,
  jaccardWordSimilarity,
  jaccardSimilarity,
  normalizeClaimText,
  claimTypeToCategory,
  VALID_CLAIM_TYPES,
  type ClaimTypeValue,
} from '../lib/claim-utils.ts';

// ---------------------------------------------------------------------------
// jaccardWordSimilarity
// ---------------------------------------------------------------------------

describe('jaccardWordSimilarity', () => {
  it('returns 1.0 for identical strings', () => {
    expect(jaccardWordSimilarity('hello world', 'hello world')).toBe(1);
  });

  it('returns 1.0 for strings that normalize to the same text', () => {
    expect(jaccardWordSimilarity('Hello World.', 'hello world')).toBe(1);
  });

  it('returns 0.0 for completely disjoint strings', () => {
    expect(jaccardWordSimilarity('apples oranges', 'cats dogs')).toBe(0);
  });

  it('returns a value between 0 and 1 for partial overlap', () => {
    const score = jaccardWordSimilarity(
      'Anthropic raised seven billion dollars',
      'Anthropic total funding reached seven billion',
    );
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('is case insensitive', () => {
    const a = 'GPT-4 SCORES 86% ON MMLU';
    const b = 'gpt-4 scores 86% on mmlu';
    expect(jaccardWordSimilarity(a, b)).toBe(1);
  });

  it('handles punctuation by stripping trailing punctuation', () => {
    // normalizeClaimText strips trailing punctuation and lowercases
    const a = 'Anthropic raised $7.3 billion.';
    const b = 'Anthropic raised $7.3 billion';
    expect(jaccardWordSimilarity(a, b)).toBe(1);
  });

  it('handles empty strings (both empty)', () => {
    // Two empty strings: both word sets are empty -> jaccardSimilarity returns 1
    expect(jaccardWordSimilarity('', '')).toBe(1);
  });

  it('handles one empty string', () => {
    expect(jaccardWordSimilarity('hello', '')).toBe(0);
    expect(jaccardWordSimilarity('', 'hello')).toBe(0);
  });

  it('treats duplicate words as a single set member', () => {
    // "the the the cat" has word set {the, cat}
    const score = jaccardWordSimilarity('the the the cat', 'the cat');
    expect(score).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// jaccardSimilarity (set-level)
// ---------------------------------------------------------------------------

describe('jaccardSimilarity', () => {
  it('returns 1.0 for identical sets', () => {
    expect(jaccardSimilarity(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
  });

  it('returns 0.0 for disjoint sets', () => {
    expect(jaccardSimilarity(new Set(['a', 'b']), new Set(['c', 'd']))).toBe(0);
  });

  it('returns 1.0 for two empty sets', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
  });

  it('returns 0.0 when one set is empty and the other is not', () => {
    expect(jaccardSimilarity(new Set(), new Set(['a']))).toBe(0);
  });

  it('computes correct ratio for partial overlap', () => {
    // {a, b, c} & {b, c, d} = intersection 2, union 4 -> 0.5
    const score = jaccardSimilarity(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']));
    expect(score).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// normalizeClaimText
// ---------------------------------------------------------------------------

describe('normalizeClaimText', () => {
  it('lowercases text', () => {
    expect(normalizeClaimText('HELLO WORLD')).toBe('hello world');
  });

  it('collapses whitespace', () => {
    expect(normalizeClaimText('hello   world')).toBe('hello world');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeClaimText('  hello  ')).toBe('hello');
  });

  it('strips trailing punctuation (period, comma, semicolon, colon, etc.)', () => {
    expect(normalizeClaimText('hello.')).toBe('hello');
    expect(normalizeClaimText('hello!')).toBe('hello');
    expect(normalizeClaimText('hello?')).toBe('hello');
    expect(normalizeClaimText('hello;')).toBe('hello');
    expect(normalizeClaimText('hello:')).toBe('hello');
    expect(normalizeClaimText('hello,,')).toBe('hello');
  });

  it('does not strip internal punctuation', () => {
    expect(normalizeClaimText('hello, world.')).toBe('hello, world');
  });

  it('handles empty string', () => {
    expect(normalizeClaimText('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// isClaimDuplicate — backfill-relevant scenarios
// ---------------------------------------------------------------------------

describe('isClaimDuplicate', () => {
  describe('exact match', () => {
    it('returns true for exact text match', () => {
      expect(isClaimDuplicate(
        'Anthropic raised $7.3 billion.',
        'Anthropic raised $7.3 billion.',
      )).toBe(true);
    });

    it('returns true for match after normalization (case + whitespace + punctuation)', () => {
      expect(isClaimDuplicate(
        'Anthropic Raised $7.3 Billion!',
        'anthropic raised $7.3 billion.',
      )).toBe(true);
    });
  });

  describe('substring containment', () => {
    it('returns true when one text is a substantial substring of the other', () => {
      // shorter = "Anthropic raised $7.3 billion" (29 chars)
      // longer  = "Anthropic raised $7.3 billion in total funding" (46 chars)
      // ratio = 29/46 ~ 0.63 > 0.6 -> duplicate
      expect(isClaimDuplicate(
        'Anthropic raised $7.3 billion',
        'Anthropic raised $7.3 billion in total funding',
      )).toBe(true);
    });

    it('returns false when substring is too short relative to longer text', () => {
      // "GPT-4" is much shorter than a full sentence
      // ratio will be well below 0.6
      expect(isClaimDuplicate(
        'GPT-4',
        'GPT-4 achieves state-of-the-art performance on multiple benchmarks.',
      )).toBe(false);
    });
  });

  describe('Jaccard similarity', () => {
    it('returns true for high Jaccard similarity (paraphrases)', () => {
      // "in 2024" vs "by 2024" — Jaccard 0.89, above 0.75 threshold
      expect(isClaimDuplicate(
        'Anthropic raised $7.3 billion in total funding in 2024.',
        'Anthropic raised $7.3 billion in total funding by 2024.',
      )).toBe(true);
    });

    it('returns false for completely different texts', () => {
      expect(isClaimDuplicate(
        'Anthropic raised $7.3 billion in total funding.',
        'Kalshi was founded in 2018 as a prediction market platform.',
      )).toBe(false);
    });
  });

  describe('threshold sensitivity', () => {
    it('matches at lower threshold (0.6) for same fact, different wording', () => {
      // Jaccard 0.75 — above the 0.6 grouping threshold used in backfill
      const a = 'Anthropic raised $7.3 billion in total funding.';
      const b = 'Anthropic has raised $7.3 billion in funding.';
      expect(isClaimDuplicate(a, b, 0.6)).toBe(true);
    });

    it('rejects at higher threshold (0.75) for loosely related text', () => {
      const a = 'Anthropic was founded in 2021 by former OpenAI researchers.';
      const b = 'Anthropic raised $7.3 billion in total funding.';
      expect(isClaimDuplicate(a, b, 0.75)).toBe(false);
    });

    it('rejects at 0.6 threshold for entirely different topics', () => {
      expect(isClaimDuplicate(
        'Kalshi was founded in 2018.',
        'The global population reached 8 billion in 2022.',
        0.6,
      )).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('returns true for two empty strings (normalize to same)', () => {
      // Both normalize to empty string "" -> exact match
      expect(isClaimDuplicate('', '')).toBe(true);
    });

    it('returns false for one empty and one non-empty string', () => {
      expect(isClaimDuplicate('', 'Anthropic raised $7.3 billion.')).toBe(false);
    });

    it('handles very short texts (under 10 chars)', () => {
      // "gpt-4" vs "gpt-4" -> exact match
      expect(isClaimDuplicate('GPT-4', 'gpt-4')).toBe(true);

      // "gpt-4" vs "gpt-3" -> different, low similarity
      expect(isClaimDuplicate('GPT-4', 'GPT-3')).toBe(false);
    });

    it('handles whitespace-only strings', () => {
      // Both normalize to empty string -> exact match
      expect(isClaimDuplicate('   ', '   ')).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// deduplicateClaims
// ---------------------------------------------------------------------------

describe('deduplicateClaims', () => {
  it('returns empty result for empty input', () => {
    const result = deduplicateClaims([], []);
    expect(result).toEqual({ unique: [], duplicateCount: 0 });
  });

  it('returns all claims when none are duplicates', () => {
    const claims = [
      { claimText: 'Anthropic raised $7.3 billion in total funding.' },
      { claimText: 'Kalshi was founded in 2018 as a prediction market.' },
      { claimText: 'OpenAI released GPT-4 in March 2023.' },
    ];
    const existing: string[] = [];
    const result = deduplicateClaims(claims, existing);
    expect(result.unique).toHaveLength(3);
    expect(result.duplicateCount).toBe(0);
  });

  it('filters out exact duplicates of existing claims', () => {
    const claims = [
      { claimText: 'Anthropic raised $7.3 billion in total funding.' },
      { claimText: 'OpenAI released GPT-4 in March 2023.' },
    ];
    const existing = ['Anthropic raised $7.3 billion in total funding.'];
    const result = deduplicateClaims(claims, existing);
    expect(result.unique).toHaveLength(1);
    expect(result.unique[0].claimText).toBe('OpenAI released GPT-4 in March 2023.');
    expect(result.duplicateCount).toBe(1);
  });

  it('filters out paraphrase duplicates at default threshold', () => {
    const claims = [
      // "in 2024" vs "by 2024" — Jaccard ~0.89, above default 0.75 threshold
      { claimText: 'Anthropic raised $7.3 billion in total funding in 2024.' },
      { claimText: 'Kalshi was founded in 2018 as a prediction market platform.' },
    ];
    const existing = [
      'Anthropic raised $7.3 billion in total funding by 2024.',
    ];
    const result = deduplicateClaims(claims, existing);
    expect(result.unique).toHaveLength(1);
    expect(result.unique[0].claimText).toContain('Kalshi');
    expect(result.duplicateCount).toBe(1);
  });

  it('handles mix of duplicates and unique claims', () => {
    const claims = [
      { claimText: 'Anthropic raised $7.3 billion in total funding.' },
      { claimText: 'Kalshi was founded in 2018 as a prediction market platform.' },
      { claimText: 'GPT-4 scores 86.4% on MMLU benchmark.' },
    ];
    const existing = [
      'Anthropic raised $7.3 billion in total funding.',
      'GPT-4 scores 86.4% on the MMLU benchmark.',
    ];
    const result = deduplicateClaims(claims, existing);
    expect(result.unique).toHaveLength(1);
    expect(result.unique[0].claimText).toContain('Kalshi');
    expect(result.duplicateCount).toBe(2);
  });

  it('respects threshold parameter — lower threshold catches more duplicates', () => {
    // Jaccard is 0.75 for this pair, so:
    // - at 0.9, NOT a dup (0.75 < 0.9)
    // - at 0.6, IS a dup (0.75 >= 0.6)
    const claims = [
      { claimText: 'Anthropic raised $7.3 billion in total funding.' },
    ];
    const existing = [
      'Anthropic has raised $7.3 billion in funding.',
    ];

    // At strict threshold 0.9, these should NOT be considered duplicates
    const strict = deduplicateClaims(claims, existing, 0.9);
    expect(strict.unique).toHaveLength(1);
    expect(strict.duplicateCount).toBe(0);

    // At loose threshold 0.6, they should be considered duplicates
    const loose = deduplicateClaims(claims, existing, 0.6);
    expect(loose.unique).toHaveLength(0);
    expect(loose.duplicateCount).toBe(1);
  });

  it('preserves claim object properties through dedup', () => {
    interface ExtendedClaim { claimText: string; claimType: string; score: number }
    const claims: ExtendedClaim[] = [
      { claimText: 'Unique claim about something.', claimType: 'factual', score: 0.9 },
    ];
    const result = deduplicateClaims(claims, []);
    expect(result.unique[0].claimType).toBe('factual');
    expect(result.unique[0].score).toBe(0.9);
  });

  it('deduplicates against existing even when existing has different casing', () => {
    const claims = [
      { claimText: 'ANTHROPIC RAISED $7.3 BILLION IN FUNDING.' },
    ];
    const existing = ['anthropic raised $7.3 billion in funding.'];
    const result = deduplicateClaims(claims, existing);
    expect(result.unique).toHaveLength(0);
    expect(result.duplicateCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// claimTypeToCategory — mapping for backfill-created claims
// ---------------------------------------------------------------------------

describe('claimTypeToCategory', () => {
  it('maps factual → factual', () => {
    expect(claimTypeToCategory('factual')).toBe('factual');
  });

  it('maps numeric → factual', () => {
    expect(claimTypeToCategory('numeric')).toBe('factual');
  });

  it('maps historical → factual', () => {
    expect(claimTypeToCategory('historical')).toBe('factual');
  });

  it('maps evaluative → opinion', () => {
    expect(claimTypeToCategory('evaluative')).toBe('opinion');
  });

  it('maps consensus → opinion', () => {
    expect(claimTypeToCategory('consensus')).toBe('opinion');
  });

  it('maps causal → analytical', () => {
    expect(claimTypeToCategory('causal')).toBe('analytical');
  });

  it('maps speculative → speculative', () => {
    expect(claimTypeToCategory('speculative')).toBe('speculative');
  });

  it('maps relational → relational', () => {
    expect(claimTypeToCategory('relational')).toBe('relational');
  });

  it('all 8 VALID_CLAIM_TYPES map to a non-empty string', () => {
    expect(VALID_CLAIM_TYPES).toHaveLength(8);
    for (const t of VALID_CLAIM_TYPES) {
      const cat = claimTypeToCategory(t);
      expect(typeof cat).toBe('string');
      expect(cat.length).toBeGreaterThan(0);
    }
  });

  it('returns factual for unknown type (default branch)', () => {
    // Force an unknown value through the type system for defensive testing
    const result = claimTypeToCategory('nonexistent' as ClaimTypeValue);
    expect(result).toBe('factual');
  });
});
