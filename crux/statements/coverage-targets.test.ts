import { describe, it, expect } from 'vitest';
import {
  resolveCoverageTargets,
  computeCoverageScore,
  computeGaps,
} from './coverage-targets.ts';

// ---------------------------------------------------------------------------
// resolveCoverageTargets
// ---------------------------------------------------------------------------

describe('resolveCoverageTargets', () => {
  it('returns specific targets for organization:frontier-lab', () => {
    const targets = resolveCoverageTargets('organization', 'frontier-lab');
    expect(targets).toBeTruthy();
    expect(targets!.financial).toBe(12);
    expect(targets!.safety).toBe(10);
  });

  it('returns specific targets for organization:safety-org', () => {
    const targets = resolveCoverageTargets('organization', 'safety-org');
    expect(targets).toBeTruthy();
    expect(targets!.safety).toBe(12);
    expect(targets!.research).toBe(10);
  });

  it('falls back to generic organization when orgType is unknown', () => {
    const targets = resolveCoverageTargets('organization', 'unknown-type');
    expect(targets).toBeTruthy();
    expect(targets!.financial).toBe(6);
  });

  it('falls back to generic organization when orgType is null', () => {
    const targets = resolveCoverageTargets('organization', null);
    expect(targets).toBeTruthy();
    expect(targets!.financial).toBe(6);
  });

  it('returns person targets', () => {
    const targets = resolveCoverageTargets('person');
    expect(targets).toBeTruthy();
    expect(targets!.research).toBe(8);
    expect(targets!.organizational).toBe(6);
  });

  it('returns model targets', () => {
    const targets = resolveCoverageTargets('model');
    expect(targets).toBeTruthy();
    expect(targets!.technical).toBe(12);
    expect(targets!.safety).toBe(8);
  });

  it('returns null for unknown entity type', () => {
    expect(resolveCoverageTargets('concept')).toBeNull();
  });

  it('returns null for unknown entity type even with orgType', () => {
    expect(resolveCoverageTargets('concept', 'frontier-lab')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeCoverageScore
// ---------------------------------------------------------------------------

describe('computeCoverageScore', () => {
  it('returns 1.0 when all categories meet targets', () => {
    const targets = { financial: 5, safety: 5 };
    const actual = { financial: 10, safety: 5 };
    expect(computeCoverageScore(actual, targets)).toBe(1);
  });

  it('returns 0 when all categories are empty', () => {
    const targets = { financial: 5, safety: 5 };
    expect(computeCoverageScore({}, targets)).toBe(0);
  });

  it('handles partial coverage correctly', () => {
    const targets = { safety: 10 };
    const actual = { safety: 5 };
    const score = computeCoverageScore(actual, targets);
    expect(score).toBe(0.5);
  });

  it('caps fill rate at 1.0 (excess does not overshoot)', () => {
    const targets = { safety: 5 };
    const actual = { safety: 100 };
    expect(computeCoverageScore(actual, targets)).toBe(1);
  });

  it('weights categories by importance', () => {
    // safety importance=0.95, relation importance=0.60
    const targets = { safety: 10, relation: 10 };
    // Only safety filled
    const actualSafetyOnly = { safety: 10, relation: 0 };
    const actualRelationOnly = { safety: 0, relation: 10 };
    const scoreSafety = computeCoverageScore(actualSafetyOnly, targets);
    const scoreRelation = computeCoverageScore(actualRelationOnly, targets);
    // Filling the more important category should give a higher score
    expect(scoreSafety).toBeGreaterThan(scoreRelation);
  });

  it('returns 0 for empty targets', () => {
    expect(computeCoverageScore({ safety: 5 }, {})).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeGaps
// ---------------------------------------------------------------------------

describe('computeGaps', () => {
  it('returns gaps sorted by priority (highest first)', () => {
    const targets = { safety: 10, financial: 10, relation: 10 };
    const actual = { safety: 0, financial: 5, relation: 10 };
    const gaps = computeGaps(actual, targets);

    expect(gaps.length).toBe(3);
    // safety has highest priority (importance 0.95, fillRate 0)
    expect(gaps[0].category).toBe('safety');
    // relation is fully filled, priority 0
    expect(gaps[gaps.length - 1].priority).toBe(0);
  });

  it('computes correct deficit', () => {
    const targets = { safety: 10 };
    const actual = { safety: 3 };
    const gaps = computeGaps(actual, targets);

    expect(gaps[0].deficit).toBe(7);
    expect(gaps[0].actual).toBe(3);
    expect(gaps[0].target).toBe(10);
  });

  it('deficit is 0 when actual exceeds target', () => {
    const targets = { safety: 5 };
    const actual = { safety: 20 };
    const gaps = computeGaps(actual, targets);

    expect(gaps[0].deficit).toBe(0);
    expect(gaps[0].fillRate).toBe(1);
    expect(gaps[0].priority).toBe(0);
  });

  it('handles missing actual counts as zero', () => {
    const targets = { safety: 10, financial: 5 };
    const gaps = computeGaps({}, targets);

    expect(gaps.length).toBe(2);
    for (const g of gaps) {
      expect(g.actual).toBe(0);
      expect(g.fillRate).toBe(0);
      expect(g.deficit).toBe(g.target);
    }
  });

  it('returns empty array for empty targets', () => {
    expect(computeGaps({ safety: 5 }, {})).toEqual([]);
  });
});
