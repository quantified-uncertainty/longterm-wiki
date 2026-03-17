/**
 * Tests for triage phase quality-based tier selection logic.
 *
 * Tests cover:
 *   - qualityScoreToGrade: numeric score → letter grade mapping
 *   - qualityBasedTier: grade + citation count → tier recommendation
 *
 * The full triagePhase function requires LLM calls + file I/O and is tested
 * via manual integration testing with `--tier=triage` on real pages.
 */

import { describe, it, expect } from 'vitest';
import { qualityScoreToGrade, qualityBasedTier } from './triage.ts';

// ── qualityScoreToGrade ───────────────────────────────────────────────────────

describe('qualityScoreToGrade', () => {
  it('assigns A for scores >= 80', () => {
    expect(qualityScoreToGrade(80)).toBe('A');
    expect(qualityScoreToGrade(90)).toBe('A');
    expect(qualityScoreToGrade(100)).toBe('A');
  });

  it('assigns B for scores 70–79', () => {
    expect(qualityScoreToGrade(70)).toBe('B');
    expect(qualityScoreToGrade(75)).toBe('B');
    expect(qualityScoreToGrade(79)).toBe('B');
  });

  it('assigns C for scores 60–69', () => {
    expect(qualityScoreToGrade(60)).toBe('C');
    expect(qualityScoreToGrade(65)).toBe('C');
    expect(qualityScoreToGrade(69)).toBe('C');
  });

  it('assigns D for scores 40–59', () => {
    expect(qualityScoreToGrade(40)).toBe('D');
    expect(qualityScoreToGrade(50)).toBe('D');
    expect(qualityScoreToGrade(59)).toBe('D');
  });

  it('assigns F for scores below 40', () => {
    expect(qualityScoreToGrade(39)).toBe('F');
    expect(qualityScoreToGrade(20)).toBe('F');
    expect(qualityScoreToGrade(0)).toBe('F');
  });

  it('boundary: 79 is B not A', () => {
    expect(qualityScoreToGrade(79)).toBe('B');
    expect(qualityScoreToGrade(80)).toBe('A');
  });

  it('boundary: 69 is C not B', () => {
    expect(qualityScoreToGrade(69)).toBe('C');
    expect(qualityScoreToGrade(70)).toBe('B');
  });

  it('boundary: 59 is D not C', () => {
    expect(qualityScoreToGrade(59)).toBe('D');
    expect(qualityScoreToGrade(60)).toBe('C');
  });

  it('boundary: 39 is F not D', () => {
    expect(qualityScoreToGrade(39)).toBe('F');
    expect(qualityScoreToGrade(40)).toBe('D');
  });
});

// ── qualityBasedTier ──────────────────────────────────────────────────────────

describe('qualityBasedTier', () => {
  // === Grade >= B AND well-cited → polish ===

  it('returns polish for grade A with 10+ citations', () => {
    const result = qualityBasedTier(85, 10);
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('polish');
    expect(result!.grade).toBe('A');
  });

  it('returns polish for grade B with exactly 10 citations', () => {
    const result = qualityBasedTier(72, 10);
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('polish');
    expect(result!.grade).toBe('B');
  });

  it('returns polish for grade B with many citations', () => {
    const result = qualityBasedTier(70, 25);
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('polish');
    expect(result!.grade).toBe('B');
  });

  it('reason mentions quality score and citation count for polish', () => {
    const result = qualityBasedTier(75, 15);
    expect(result!.reason).toContain('75');
    expect(result!.reason).toContain('15');
    expect(result!.reason).toContain('polish');
  });

  // === Grade >= B BUT low citations → standard (needs more sourcing) ===

  it('returns standard for grade B with 9 citations (below threshold)', () => {
    const result = qualityBasedTier(70, 9);
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('standard');
    expect(result!.grade).toBe('B');
  });

  it('returns standard for grade A with 0 citations', () => {
    const result = qualityBasedTier(90, 0);
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('standard');
    expect(result!.grade).toBe('A');
  });

  it('reason mentions citation note when grade >= B but citations < 10', () => {
    const result = qualityBasedTier(75, 5);
    expect(result!.reason).toContain('5');
    expect(result!.reason).toContain('citations');
  });

  // === Grade C (60-69) → standard ===

  it('returns standard for grade C regardless of citations', () => {
    const result = qualityBasedTier(65, 20);
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('standard');
    expect(result!.grade).toBe('C');
  });

  it('returns standard for grade C with no citations', () => {
    const result = qualityBasedTier(60, 0);
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('standard');
    expect(result!.grade).toBe('C');
  });

  // === Grade < C (quality < 60) → deep ===

  it('returns deep for grade D', () => {
    const result = qualityBasedTier(50, 5);
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('deep');
    expect(result!.grade).toBe('D');
  });

  it('returns deep for grade F', () => {
    const result = qualityBasedTier(20, 0);
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('deep');
    expect(result!.grade).toBe('F');
  });

  it('returns deep even for grade D with many citations', () => {
    // Citation count should not override the need for deep improvement when grade < C
    const result = qualityBasedTier(55, 30);
    expect(result!.tier).toBe('deep');
  });

  it('returns deep for quality score 0', () => {
    const result = qualityBasedTier(0, 0);
    expect(result!.tier).toBe('deep');
  });

  it('reason mentions quality score for deep tier', () => {
    const result = qualityBasedTier(45, 0);
    expect(result!.reason).toContain('45');
  });

  // === No quality data → null ===

  it('returns null when quality score is null', () => {
    expect(qualityBasedTier(null, 10)).toBeNull();
  });

  it('returns null when quality score is undefined', () => {
    expect(qualityBasedTier(undefined, 10)).toBeNull();
  });

  // === Boundary cases ===

  it('boundary: quality 59 → deep (grade D, not standard)', () => {
    expect(qualityBasedTier(59, 0)!.tier).toBe('deep');
  });

  it('boundary: quality 60 → standard (grade C threshold)', () => {
    expect(qualityBasedTier(60, 0)!.tier).toBe('standard');
  });

  it('boundary: quality 69 + 10 citations → standard (grade C, not polish)', () => {
    // Even with 10 citations, C-grade does not qualify for polish
    expect(qualityBasedTier(69, 10)!.tier).toBe('standard');
  });

  it('boundary: quality 70 + 10 citations → polish (grade B threshold)', () => {
    expect(qualityBasedTier(70, 10)!.tier).toBe('polish');
  });

  it('boundary: quality 70 + 9 citations → standard (just below citation threshold)', () => {
    expect(qualityBasedTier(70, 9)!.tier).toBe('standard');
  });
});
