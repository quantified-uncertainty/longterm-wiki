import { describe, it, expect } from 'vitest';
import {
  computeHallucinationRisk,
  computeAccuracyRisk,
  resolveEntityType,
  BASELINE_SCORE,
  THRESHOLD_LOW,
  THRESHOLD_MEDIUM,
  type RiskInput,
} from './hallucination-risk.ts';

// ---------------------------------------------------------------------------
// resolveEntityType
// ---------------------------------------------------------------------------

describe('resolveEntityType', () => {
  it('resolves known aliases', () => {
    expect(resolveEntityType('researcher')).toBe('person');
    expect(resolveEntityType('lab')).toBe('organization');
    expect(resolveEntityType('lab-frontier')).toBe('organization');
    expect(resolveEntityType('concepts')).toBe('concept');
    expect(resolveEntityType('events')).toBe('event');
  });

  it('passes through canonical types unchanged', () => {
    expect(resolveEntityType('person')).toBe('person');
    expect(resolveEntityType('risk')).toBe('risk');
    expect(resolveEntityType('model')).toBe('model');
  });

  it('returns null for null/undefined input', () => {
    expect(resolveEntityType(null)).toBeNull();
    expect(resolveEntityType(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeAccuracyRisk
// ---------------------------------------------------------------------------

describe('computeAccuracyRisk', () => {
  it('returns no risk when no citations are checked', () => {
    expect(computeAccuracyRisk(0, 0)).toEqual({ score: 0, factor: null });
  });

  it('returns no risk when all citations are accurate', () => {
    expect(computeAccuracyRisk(10, 0)).toEqual({ score: 0, factor: null });
  });

  it('returns +5 / some-inaccurate for low inaccuracy', () => {
    expect(computeAccuracyRisk(10, 1)).toEqual({ score: 5, factor: 'some-inaccurate' });
  });

  it('returns +10 / many-inaccurate when >30%', () => {
    expect(computeAccuracyRisk(10, 4)).toEqual({ score: 10, factor: 'many-inaccurate' });
  });

  it('returns +20 / majority-inaccurate when >50%', () => {
    expect(computeAccuracyRisk(10, 6)).toEqual({ score: 20, factor: 'majority-inaccurate' });
  });

  it('handles edge cases safely', () => {
    expect(computeAccuracyRisk(-1, 0)).toEqual({ score: 0, factor: null });
    expect(computeAccuracyRisk(10, -1)).toEqual({ score: 0, factor: null });
    expect(computeAccuracyRisk(NaN, 0)).toEqual({ score: 0, factor: null });
    // inaccurate > checked → clamps
    expect(computeAccuracyRisk(5, 10).factor).toBe('majority-inaccurate');
  });
});

// ---------------------------------------------------------------------------
// computeHallucinationRisk — baseline
// ---------------------------------------------------------------------------

describe('computeHallucinationRisk', () => {
  // Base input designed to trigger zero factors:
  // - citation density = 3/1000*1000 = 3, between LOW(2) and MODERATE(4) thresholds
  // - externalLinks = 2, not < 2
  // - rigor = 5, not < 4 and not >= 7
  // - quality = 50, not < 40 and not >= 80
  // - wordCount = 1000, not < 300
  const baseInput: RiskInput = {
    entityType: null,
    wordCount: 1000,
    footnoteCount: 3,
    externalLinks: 2,
    rigor: 5,
    quality: 50,
  };

  it('returns medium for a typical page with baseline inputs', () => {
    const result = computeHallucinationRisk(baseInput);
    expect(result.level).toBe('medium');
    expect(result.score).toBe(BASELINE_SCORE);
    expect(result.factors).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Risk-increasing factors
  // ---------------------------------------------------------------------------

  it('adds biographical risk for person entities', () => {
    const result = computeHallucinationRisk({ ...baseInput, entityType: 'person' });
    expect(result.score).toBeGreaterThan(BASELINE_SCORE);
    expect(result.factors).toContain('biographical-claims');
  });

  it('adds factual risk for event entities', () => {
    const result = computeHallucinationRisk({ ...baseInput, entityType: 'event' });
    expect(result.score).toBeGreaterThan(BASELINE_SCORE);
    expect(result.factors).toContain('specific-factual-claims');
  });

  it('adds no-citations risk for uncited long pages', () => {
    const result = computeHallucinationRisk({
      ...baseInput,
      footnoteCount: 0,
      wordCount: 1000,
    });
    expect(result.factors).toContain('no-citations');
  });

  it('adds low-citation-density for sparse citations', () => {
    const result = computeHallucinationRisk({
      ...baseInput,
      footnoteCount: 1,
      wordCount: 2000,
    });
    expect(result.factors).toContain('low-citation-density');
  });

  it('adds low-rigor-score for rigor < 4', () => {
    const result = computeHallucinationRisk({ ...baseInput, rigor: 2 });
    expect(result.factors).toContain('low-rigor-score');
  });

  it('adds low-quality-score for quality < 40', () => {
    const result = computeHallucinationRisk({ ...baseInput, quality: 30 });
    expect(result.factors).toContain('low-quality-score');
  });

  it('adds few-external-sources for pages with few links', () => {
    const result = computeHallucinationRisk({
      ...baseInput,
      externalLinks: 0,
      wordCount: 1000,
    });
    expect(result.factors).toContain('few-external-sources');
  });

  it('adds no-human-review when hasHumanReview is false', () => {
    const result = computeHallucinationRisk({
      ...baseInput,
      hasHumanReview: false,
    });
    expect(result.factors).toContain('no-human-review');
  });

  it('adds accuracy risk factors', () => {
    const result = computeHallucinationRisk({
      ...baseInput,
      accuracy: { checked: 10, inaccurate: 6 },
    });
    expect(result.factors).toContain('majority-inaccurate');
  });

  // ---------------------------------------------------------------------------
  // Risk-decreasing factors
  // ---------------------------------------------------------------------------

  it('reduces score for well-cited pages', () => {
    const result = computeHallucinationRisk({
      ...baseInput,
      footnoteCount: 20,
      wordCount: 1000,
    });
    expect(result.score).toBeLessThan(BASELINE_SCORE);
    expect(result.factors).toContain('well-cited');
  });

  it('reduces score for high rigor', () => {
    const result = computeHallucinationRisk({ ...baseInput, rigor: 8 });
    expect(result.score).toBeLessThan(BASELINE_SCORE);
    expect(result.factors).toContain('high-rigor');
  });

  it('reduces score for structural/conceptual content', () => {
    const result = computeHallucinationRisk({
      ...baseInput,
      entityType: 'concept',
    });
    expect(result.score).toBeLessThan(BASELINE_SCORE);
    expect(result.factors).toContain('conceptual-content');
  });

  it('reduces score for structured formats', () => {
    const result = computeHallucinationRisk({
      ...baseInput,
      contentFormat: 'table',
    });
    expect(result.score).toBeLessThan(BASELINE_SCORE);
    expect(result.factors).toContain('structured-format');
  });

  it('reduces score for minimal content', () => {
    const result = computeHallucinationRisk({
      ...baseInput,
      wordCount: 100,
      footnoteCount: 1,
    });
    expect(result.factors).toContain('minimal-content');
  });

  it('reduces score for high quality', () => {
    const result = computeHallucinationRisk({ ...baseInput, quality: 90 });
    expect(result.score).toBeLessThan(BASELINE_SCORE);
    expect(result.factors).toContain('high-quality');
  });

  it('reduces score for human-reviewed pages', () => {
    const result = computeHallucinationRisk({
      ...baseInput,
      hasHumanReview: true,
    });
    expect(result.score).toBeLessThan(BASELINE_SCORE);
    expect(result.factors).toContain('human-reviewed');
  });

  // ---------------------------------------------------------------------------
  // Score clamping and level classification
  // ---------------------------------------------------------------------------

  it('clamps score to 0 minimum', () => {
    // Many risk-decreasing factors
    const result = computeHallucinationRisk({
      entityType: 'concept',
      wordCount: 100,
      footnoteCount: 20,
      rigor: 9,
      quality: 95,
      hasHumanReview: true,
      contentFormat: 'table',
    });
    expect(result.score).toBe(0);
    expect(result.level).toBe('low');
  });

  it('clamps score to 100 maximum', () => {
    // Many risk-increasing factors
    const result = computeHallucinationRisk({
      entityType: 'person',
      wordCount: 2000,
      footnoteCount: 0,
      rigor: 1,
      quality: 10,
      externalLinks: 0,
      hasHumanReview: false,
      accuracy: { checked: 10, inaccurate: 8 },
    });
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('classifies level correctly at boundaries', () => {
    // We can't easily hit exact boundaries, so test the classification logic
    // by checking that the thresholds are applied
    const lowResult = computeHallucinationRisk({
      ...baseInput,
      entityType: 'concept',
      footnoteCount: 20,
      rigor: 9,
      quality: 95,
      hasHumanReview: true,
    });
    expect(lowResult.level).toBe('low');
    expect(lowResult.score).toBeLessThanOrEqual(THRESHOLD_LOW);

    const highResult = computeHallucinationRisk({
      ...baseInput,
      entityType: 'person',
      footnoteCount: 0,
      rigor: 1,
      quality: 10,
      hasHumanReview: false,
    });
    expect(highResult.level).toBe('high');
    expect(highResult.score).toBeGreaterThan(THRESHOLD_MEDIUM);
  });

  // ---------------------------------------------------------------------------
  // Content integrity
  // ---------------------------------------------------------------------------

  it('includes integrity factors when contentBody has issues', () => {
    // Body with orphaned footnote references (truncation signal)
    // 3 refs, only 1 def → 2/3 orphaned ratio > 0.5 → severe-truncation
    const bodyWithOrphans = `
Some text with a reference[^1] and another[^2] and[^3].

[^1]: https://example.com/source1 Source 1
`;
    const result = computeHallucinationRisk({
      ...baseInput,
      contentBody: bodyWithOrphans,
    });
    expect(result.factors).toContain('severe-truncation');
    expect(result.integrityIssues).toBeDefined();
    expect(result.integrityIssues).toContain('severe-truncation');
  });

  it('skips integrity checks when contentBody is null', () => {
    const result = computeHallucinationRisk({
      ...baseInput,
      contentBody: null,
    });
    expect(result.integrityIssues).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Optional fields
  // ---------------------------------------------------------------------------

  it('works with minimal required fields', () => {
    const result = computeHallucinationRisk({
      entityType: null,
      wordCount: 0,
      footnoteCount: 0,
      rigor: null,
      quality: null,
    });
    expect(result.level).toBeDefined();
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('includes rComponentCount in citation total', () => {
    // 0 footnotes + 10 R components = citation density of 10/1000 = 10 > 8 → well-cited
    const result = computeHallucinationRisk({
      ...baseInput,
      footnoteCount: 0,
      rComponentCount: 10,
      wordCount: 1000,
    });
    expect(result.factors).toContain('well-cited');
    expect(result.factors).not.toContain('no-citations');
  });
});
