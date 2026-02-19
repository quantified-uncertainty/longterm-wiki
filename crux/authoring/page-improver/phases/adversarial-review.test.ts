/**
 * Tests for adversarial-review phase logic.
 *
 * Tests the Zod schema validation and the normalization logic that
 * derives reResearchQueries from gaps (rather than trusting the LLM's own
 * reResearchQueries field, which can be inconsistent).
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AdversarialGapSchema, AdversarialReviewResultSchema, parseAndValidate } from './json-parsing.ts';

// ── Schema validation tests ─────────────────────────────────────────────────

describe('AdversarialGapSchema', () => {
  it('accepts a valid re-research gap', () => {
    const gap = {
      type: 'fact-density',
      description: 'First paragraph has no specific facts',
      reResearchQuery: 'founding year Anthropic CEO',
      actionType: 're-research',
    };
    expect(AdversarialGapSchema.safeParse(gap).success).toBe(true);
  });

  it('accepts a valid edit gap without reResearchQuery', () => {
    const gap = {
      type: 'redundancy',
      description: 'Sections 2 and 4 cover identical ground',
      actionType: 'edit',
    };
    expect(AdversarialGapSchema.safeParse(gap).success).toBe(true);
  });

  it('accepts a none-action advisory gap', () => {
    const gap = {
      type: 'source-gap',
      description: 'Could mention related work',
      actionType: 'none',
    };
    expect(AdversarialGapSchema.safeParse(gap).success).toBe(true);
  });

  it('rejects a gap with empty description', () => {
    const gap = {
      type: 'speculation',
      description: '',
      actionType: 'edit',
    };
    expect(AdversarialGapSchema.safeParse(gap).success).toBe(false);
  });

  it('rejects an unknown gap type', () => {
    const gap = {
      type: 'hallucination',
      description: 'This type does not exist',
      actionType: 'edit',
    };
    expect(AdversarialGapSchema.safeParse(gap).success).toBe(false);
  });

  it('rejects an unknown actionType', () => {
    const gap = {
      type: 'fact-density',
      description: 'Some gap',
      actionType: 'fix',
    };
    expect(AdversarialGapSchema.safeParse(gap).success).toBe(false);
  });

  it('accepts all five valid gap types', () => {
    const validTypes = ['fact-density', 'speculation', 'missing-standard-data', 'redundancy', 'source-gap'];
    for (const type of validTypes) {
      const gap = { type, description: 'test gap', actionType: 'none' };
      expect(AdversarialGapSchema.safeParse(gap).success).toBe(true);
    }
  });
});

describe('AdversarialReviewResultSchema', () => {
  it('accepts a valid review result with gaps', () => {
    const result = {
      gaps: [
        { type: 'speculation', description: 'Unsourced claim', actionType: 're-research', reResearchQuery: 'query' },
        { type: 'redundancy', description: 'Duplicate sections', actionType: 'edit' },
      ],
      needsReResearch: true,
      reResearchQueries: ['query'],
      overallAssessment: 'Two issues found.',
    };
    expect(AdversarialReviewResultSchema.safeParse(result).success).toBe(true);
  });

  it('accepts an empty review result (no gaps)', () => {
    const result = {
      gaps: [],
      needsReResearch: false,
      reResearchQueries: [],
      overallAssessment: 'Page meets quality standards.',
    };
    expect(AdversarialReviewResultSchema.safeParse(result).success).toBe(true);
  });

  it('rejects a result with an invalid gap type nested inside', () => {
    const result = {
      gaps: [{ type: 'invented-type', description: 'x', actionType: 'edit' }],
      needsReResearch: false,
      reResearchQueries: [],
      overallAssessment: 'ok',
    };
    expect(AdversarialReviewResultSchema.safeParse(result).success).toBe(false);
  });

  it('rejects a result missing required fields', () => {
    const result = {
      gaps: [],
      // missing needsReResearch, reResearchQueries, overallAssessment
    };
    expect(AdversarialReviewResultSchema.safeParse(result).success).toBe(false);
  });
});

// ── Normalization tests ─────────────────────────────────────────────────────

describe('adversarialReview normalization (reResearchQueries derived from gaps)', () => {
  /**
   * This tests the logic that should run after parseAndValidate: the LLM's
   * reResearchQueries field should be overwritten by the queries derived from
   * gaps where actionType === 're-research' && reResearchQuery is set.
   *
   * This ensures the downstream loop gets accurate queries even if the LLM
   * summarized the list incorrectly.
   */

  function normalizeReview(review: z.infer<typeof AdversarialReviewResultSchema>) {
    const reSearchGaps = review.gaps.filter(
      g => g.actionType === 're-research' && g.reResearchQuery,
    );
    review.needsReResearch = reSearchGaps.length > 0;
    review.reResearchQueries = reSearchGaps.map(g => g.reResearchQuery as string);
    return review;
  }

  it('derives reResearchQueries correctly when LLM provided accurate list', () => {
    const review = {
      gaps: [
        { type: 'fact-density' as const, description: 'gap 1', actionType: 're-research' as const, reResearchQuery: 'query A' },
        { type: 'redundancy' as const, description: 'gap 2', actionType: 'edit' as const },
      ],
      needsReResearch: true,
      reResearchQueries: ['query A'],
      overallAssessment: 'test',
    };
    const normalized = normalizeReview(review);
    expect(normalized.reResearchQueries).toEqual(['query A']);
    expect(normalized.needsReResearch).toBe(true);
  });

  it('sets needsReResearch=false when all gaps are edit/none', () => {
    const review = {
      gaps: [
        { type: 'redundancy' as const, description: 'dup sections', actionType: 'edit' as const },
        { type: 'source-gap' as const, description: 'advisory', actionType: 'none' as const },
      ],
      needsReResearch: true, // LLM incorrectly said true
      reResearchQueries: ['some query'], // LLM incorrectly included a query
      overallAssessment: 'test',
    };
    const normalized = normalizeReview(review);
    expect(normalized.needsReResearch).toBe(false);
    expect(normalized.reResearchQueries).toEqual([]);
  });

  it('handles gaps without reResearchQuery even when actionType is re-research', () => {
    // LLM set actionType=re-research but forgot to include the query
    const review = {
      gaps: [
        { type: 'speculation' as const, description: 'unsourced', actionType: 're-research' as const },
        // no reResearchQuery
      ],
      needsReResearch: true,
      reResearchQueries: [],
      overallAssessment: 'test',
    };
    const normalized = normalizeReview(review);
    // Should not include this gap's query since it's undefined
    expect(normalized.reResearchQueries).toEqual([]);
    expect(normalized.needsReResearch).toBe(false);
  });

  it('handles empty gaps array', () => {
    const review = {
      gaps: [],
      needsReResearch: false,
      reResearchQueries: [],
      overallAssessment: 'clean page',
    };
    const normalized = normalizeReview(review);
    expect(normalized.needsReResearch).toBe(false);
    expect(normalized.reResearchQueries).toEqual([]);
  });
});
