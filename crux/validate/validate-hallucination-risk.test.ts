import { describe, it, expect } from 'vitest';
import { computeAccuracyRisk } from './validate-hallucination-risk.ts';

describe('computeAccuracyRisk', () => {
  it('returns no risk when no citations are checked', () => {
    const result = computeAccuracyRisk(0, 0);
    expect(result.score).toBe(0);
    expect(result.factor).toBeNull();
  });

  it('returns no risk when all citations are accurate', () => {
    const result = computeAccuracyRisk(10, 0);
    expect(result.score).toBe(0);
    expect(result.factor).toBeNull();
  });

  it('returns +5 / some-inaccurate when a minority are inaccurate', () => {
    // 1 out of 10 = 10%
    const result = computeAccuracyRisk(10, 1);
    expect(result.score).toBe(5);
    expect(result.factor).toBe('some-inaccurate');
  });

  it('returns +5 for exactly 30% inaccurate (boundary)', () => {
    // 3 out of 10 = 30% — not OVER 30%, so "some-inaccurate"
    const result = computeAccuracyRisk(10, 3);
    expect(result.score).toBe(5);
    expect(result.factor).toBe('some-inaccurate');
  });

  it('returns +10 / many-inaccurate when >30% are inaccurate', () => {
    // 4 out of 10 = 40%
    const result = computeAccuracyRisk(10, 4);
    expect(result.score).toBe(10);
    expect(result.factor).toBe('many-inaccurate');
  });

  it('returns +10 for exactly 50% inaccurate (boundary)', () => {
    // 5 out of 10 = 50% — not OVER 50%, so "many-inaccurate"
    const result = computeAccuracyRisk(10, 5);
    expect(result.score).toBe(10);
    expect(result.factor).toBe('many-inaccurate');
  });

  it('returns +20 / majority-inaccurate when >50% are inaccurate', () => {
    // 6 out of 10 = 60%
    const result = computeAccuracyRisk(10, 6);
    expect(result.score).toBe(20);
    expect(result.factor).toBe('majority-inaccurate');
  });

  it('returns +20 when all citations are inaccurate', () => {
    const result = computeAccuracyRisk(5, 5);
    expect(result.score).toBe(20);
    expect(result.factor).toBe('majority-inaccurate');
  });

  it('handles single citation correctly', () => {
    // 1 out of 1 = 100%
    const inaccurate = computeAccuracyRisk(1, 1);
    expect(inaccurate.score).toBe(20);
    expect(inaccurate.factor).toBe('majority-inaccurate');

    // 0 out of 1 = 0%
    const accurate = computeAccuracyRisk(1, 0);
    expect(accurate.score).toBe(0);
    expect(accurate.factor).toBeNull();
  });

  it('works with large numbers', () => {
    // 51 out of 100 = 51%
    const result = computeAccuracyRisk(100, 51);
    expect(result.score).toBe(20);
    expect(result.factor).toBe('majority-inaccurate');
  });

  it('transitions correctly at threshold boundaries', () => {
    // Test the exact boundary at 30%: 3/10 = 0.3 (not >0.3)
    expect(computeAccuracyRisk(10, 3).factor).toBe('some-inaccurate');
    // Just over: 31/100 = 0.31 (>0.3)
    expect(computeAccuracyRisk(100, 31).factor).toBe('many-inaccurate');

    // Test the exact boundary at 50%: 5/10 = 0.5 (not >0.5)
    expect(computeAccuracyRisk(10, 5).factor).toBe('many-inaccurate');
    // Just over: 51/100 = 0.51 (>0.5)
    expect(computeAccuracyRisk(100, 51).factor).toBe('majority-inaccurate');
  });
});
