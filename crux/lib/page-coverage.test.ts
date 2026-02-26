import { describe, it, expect } from 'vitest';
import {
  computePageCoverage,
  getRecommendedTargets,
  getMetricStatus,
  getRatioStatus,
  ENTITY_LIKE_TYPES,
  FACTS_GREEN_THRESHOLD,
  type CoverageInput,
} from './page-coverage.ts';

// ---------------------------------------------------------------------------
// Helper: minimal valid input for computePageCoverage
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<CoverageInput> = {}): CoverageInput {
  return {
    wordCount: 1000,
    contentFormat: 'article',
    llmSummary: 'A brief summary.',
    updateFrequency: 30,
    hasEntity: true,
    changeHistoryCount: 1,
    tableCount: 4,
    diagramCount: 0,
    internalLinks: 8,
    externalLinks: 5,
    footnoteCount: 3,
    resourceCount: 3,
    quotesWithQuotes: 0,
    quotesTotal: 0,
    accuracyChecked: 0,
    accuracyTotal: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ENTITY_LIKE_TYPES
// ---------------------------------------------------------------------------

describe('ENTITY_LIKE_TYPES', () => {
  it('includes person', () => {
    expect(ENTITY_LIKE_TYPES.has('person')).toBe(true);
  });

  it('includes organization', () => {
    expect(ENTITY_LIKE_TYPES.has('organization')).toBe(true);
  });

  it('does not include concept', () => {
    expect(ENTITY_LIKE_TYPES.has('concept')).toBe(false);
  });

  it('does not include model', () => {
    expect(ENTITY_LIKE_TYPES.has('model')).toBe(false);
  });

  it('does not include risk', () => {
    expect(ENTITY_LIKE_TYPES.has('risk')).toBe(false);
  });

  it('does not include analysis', () => {
    expect(ENTITY_LIKE_TYPES.has('analysis')).toBe(false);
  });

  it('does not include approach', () => {
    expect(ENTITY_LIKE_TYPES.has('approach')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FACTS_GREEN_THRESHOLD
// ---------------------------------------------------------------------------

describe('FACTS_GREEN_THRESHOLD', () => {
  it('is 5', () => {
    expect(FACTS_GREEN_THRESHOLD).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// getMetricStatus
// ---------------------------------------------------------------------------

describe('getMetricStatus', () => {
  it('returns green when actual >= target', () => {
    expect(getMetricStatus(5, 5)).toBe('green');
    expect(getMetricStatus(10, 5)).toBe('green');
  });

  it('returns amber when actual > 0 but below target', () => {
    expect(getMetricStatus(2, 5)).toBe('amber');
    expect(getMetricStatus(1, 10)).toBe('amber');
  });

  it('returns red when actual is 0 and target > 0', () => {
    expect(getMetricStatus(0, 5)).toBe('red');
  });

  it('returns green for actual > 0 when target is 0', () => {
    expect(getMetricStatus(1, 0)).toBe('green');
  });

  it('returns red for actual 0 when target is 0', () => {
    expect(getMetricStatus(0, 0)).toBe('red');
  });

  it('returns green for actual > 0 when target is undefined', () => {
    expect(getMetricStatus(3, undefined)).toBe('green');
  });

  it('returns red for actual 0 when target is undefined', () => {
    expect(getMetricStatus(0, undefined)).toBe('red');
  });
});

// ---------------------------------------------------------------------------
// getRatioStatus
// ---------------------------------------------------------------------------

describe('getRatioStatus', () => {
  it('returns red when denominator is 0', () => {
    expect(getRatioStatus(0, 0)).toBe('red');
    expect(getRatioStatus(5, 0)).toBe('red');
  });

  it('returns green when ratio >= 75%', () => {
    expect(getRatioStatus(75, 100)).toBe('green');
    expect(getRatioStatus(10, 10)).toBe('green');
    expect(getRatioStatus(4, 5)).toBe('green'); // 80%
  });

  it('returns amber when numerator > 0 but ratio < 75%', () => {
    expect(getRatioStatus(1, 100)).toBe('amber');
    expect(getRatioStatus(74, 100)).toBe('amber');
  });

  it('returns red when numerator is 0 and denominator > 0', () => {
    expect(getRatioStatus(0, 10)).toBe('red');
  });
});

// ---------------------------------------------------------------------------
// getRecommendedTargets
// ---------------------------------------------------------------------------

describe('getRecommendedTargets', () => {
  it('returns table-format targets for table format', () => {
    const targets = getRecommendedTargets(1000, 'table');
    expect(targets.tables).toBeGreaterThanOrEqual(2);
    expect(targets.diagrams).toBeDefined();
  });

  it('returns diagram-format targets for diagram format', () => {
    const targets = getRecommendedTargets(1000, 'diagram');
    expect(targets.diagrams).toBeGreaterThanOrEqual(1);
  });

  it('returns index-format targets for index format', () => {
    const targets = getRecommendedTargets(1000, 'index');
    expect(targets.diagrams).toBe(0);
    expect(targets.footnotes).toBe(0);
    expect(targets.internalLinks).toBeGreaterThanOrEqual(5);
  });

  it('returns index-format targets for dashboard format', () => {
    const targets = getRecommendedTargets(1000, 'dashboard');
    expect(targets.diagrams).toBe(0);
  });

  it('returns default article targets for unknown format', () => {
    const targets = getRecommendedTargets(1000, 'article');
    expect(targets.tables).toBeGreaterThanOrEqual(1);
    expect(targets.footnotes).toBeGreaterThanOrEqual(2);
  });

  it('applies minimums at low word counts', () => {
    const targets = getRecommendedTargets(100, 'article');
    expect(targets.tables).toBeGreaterThanOrEqual(1);
    expect(targets.internalLinks).toBeGreaterThanOrEqual(3);
    expect(targets.footnotes).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// computePageCoverage — boolean items
// ---------------------------------------------------------------------------

describe('computePageCoverage — boolean items', () => {
  it('llmSummary green when present', () => {
    const result = computePageCoverage(makeInput({ llmSummary: 'Summary text' }));
    expect(result.items.llmSummary).toBe('green');
  });

  it('llmSummary red when absent', () => {
    const result = computePageCoverage(makeInput({ llmSummary: null }));
    expect(result.items.llmSummary).toBe('red');
  });

  it('schedule green when updateFrequency is set', () => {
    const result = computePageCoverage(makeInput({ updateFrequency: 14 }));
    expect(result.items.schedule).toBe('green');
  });

  it('schedule red when updateFrequency is null', () => {
    const result = computePageCoverage(makeInput({ updateFrequency: null }));
    expect(result.items.schedule).toBe('red');
  });

  it('entity green when hasEntity is true', () => {
    const result = computePageCoverage(makeInput({ hasEntity: true }));
    expect(result.items.entity).toBe('green');
  });

  it('entity red when hasEntity is false', () => {
    const result = computePageCoverage(makeInput({ hasEntity: false }));
    expect(result.items.entity).toBe('red');
  });

  it('editHistory green when changeHistoryCount > 0', () => {
    const result = computePageCoverage(makeInput({ changeHistoryCount: 3 }));
    expect(result.items.editHistory).toBe('green');
  });

  it('editHistory red when changeHistoryCount is 0', () => {
    const result = computePageCoverage(makeInput({ changeHistoryCount: 0 }));
    expect(result.items.editHistory).toBe('red');
  });
});

// ---------------------------------------------------------------------------
// computePageCoverage — overview conditional scoring
// ---------------------------------------------------------------------------

describe('computePageCoverage — overview conditional scoring', () => {
  it('overview item scored for article format when hasOverview is defined', () => {
    const result = computePageCoverage(
      makeInput({ contentFormat: 'article', hasOverview: true }),
    );
    expect(result.items).toHaveProperty('overview');
    expect(result.items.overview).toBe('green');
  });

  it('overview green when hasOverview is true (article)', () => {
    const result = computePageCoverage(
      makeInput({ contentFormat: 'article', hasOverview: true }),
    );
    expect(result.items.overview).toBe('green');
  });

  it('overview red when hasOverview is false (article)', () => {
    const result = computePageCoverage(
      makeInput({ contentFormat: 'article', hasOverview: false }),
    );
    expect(result.items.overview).toBe('red');
  });

  it('overview item scored for diagram format when hasOverview is defined', () => {
    const result = computePageCoverage(
      makeInput({ contentFormat: 'diagram', hasOverview: true }),
    );
    expect(result.items).toHaveProperty('overview');
    expect(result.items.overview).toBe('green');
  });

  it('overview item NOT scored for table format', () => {
    const result = computePageCoverage(
      makeInput({ contentFormat: 'table', hasOverview: true }),
    );
    expect(result.items).not.toHaveProperty('overview');
  });

  it('overview item NOT scored for index format', () => {
    const result = computePageCoverage(
      makeInput({ contentFormat: 'index', hasOverview: false }),
    );
    expect(result.items).not.toHaveProperty('overview');
  });

  it('overview item NOT scored for dashboard format', () => {
    const result = computePageCoverage(
      makeInput({ contentFormat: 'dashboard', hasOverview: true }),
    );
    expect(result.items).not.toHaveProperty('overview');
  });

  it('overview item omitted when hasOverview is undefined (article format)', () => {
    const result = computePageCoverage(
      makeInput({ contentFormat: 'article', hasOverview: undefined }),
    );
    expect(result.items).not.toHaveProperty('overview');
  });

  it('overview item omitted when hasOverview is undefined (diagram format)', () => {
    const result = computePageCoverage(
      makeInput({ contentFormat: 'diagram', hasOverview: undefined }),
    );
    expect(result.items).not.toHaveProperty('overview');
  });

  it('overview scored for empty/missing contentFormat (treated as article)', () => {
    const result = computePageCoverage(
      makeInput({ contentFormat: '', hasOverview: true }),
    );
    expect(result.items).toHaveProperty('overview');
    expect(result.items.overview).toBe('green');
  });

  it('overview counts toward total when present', () => {
    const withOverview = computePageCoverage(
      makeInput({ contentFormat: 'article', hasOverview: true }),
    );
    const withoutOverview = computePageCoverage(
      makeInput({ contentFormat: 'table', hasOverview: true }),
    );
    expect(withOverview.total).toBe(withoutOverview.total + 1);
  });
});

// ---------------------------------------------------------------------------
// computePageCoverage — facts conditional scoring
// ---------------------------------------------------------------------------

describe('computePageCoverage — facts scoring for person/organization', () => {
  it('facts item scored for person entityType', () => {
    const result = computePageCoverage(
      makeInput({ entityType: 'person', factCount: 0 }),
    );
    expect(result.items).toHaveProperty('facts');
  });

  it('facts item scored for organization entityType', () => {
    const result = computePageCoverage(
      makeInput({ entityType: 'organization', factCount: 0 }),
    );
    expect(result.items).toHaveProperty('facts');
  });

  it('facts green when factCount >= FACTS_GREEN_THRESHOLD (5)', () => {
    const result = computePageCoverage(
      makeInput({ entityType: 'person', factCount: 5 }),
    );
    expect(result.items.facts).toBe('green');
  });

  it('facts green when factCount > FACTS_GREEN_THRESHOLD', () => {
    const result = computePageCoverage(
      makeInput({ entityType: 'organization', factCount: 10 }),
    );
    expect(result.items.facts).toBe('green');
  });

  it('facts amber when 1 <= factCount < FACTS_GREEN_THRESHOLD', () => {
    const result = computePageCoverage(
      makeInput({ entityType: 'person', factCount: 1 }),
    );
    expect(result.items.facts).toBe('amber');
  });

  it('facts amber at factCount 4 (one below threshold)', () => {
    const result = computePageCoverage(
      makeInput({ entityType: 'person', factCount: 4 }),
    );
    expect(result.items.facts).toBe('amber');
  });

  it('facts red when factCount is 0', () => {
    const result = computePageCoverage(
      makeInput({ entityType: 'person', factCount: 0 }),
    );
    expect(result.items.facts).toBe('red');
  });

  it('facts red when factCount is undefined (person page)', () => {
    const result = computePageCoverage(
      makeInput({ entityType: 'person', factCount: undefined }),
    );
    expect(result.items.facts).toBe('red');
  });

  it('facts counts toward total for person page', () => {
    const withFacts = computePageCoverage(
      makeInput({ entityType: 'person', factCount: 5 }),
    );
    const withoutFacts = computePageCoverage(
      makeInput({ entityType: undefined, factCount: 5 }),
    );
    expect(withFacts.total).toBe(withoutFacts.total + 1);
  });
});

describe('computePageCoverage — facts NOT scored for non-entity types', () => {
  const nonEntityTypes = ['concept', 'risk', 'model', 'analysis', 'approach', 'event'];

  for (const entityType of nonEntityTypes) {
    it(`facts item NOT present for entityType="${entityType}"`, () => {
      const result = computePageCoverage(
        makeInput({ entityType, factCount: 10 }),
      );
      expect(result.items).not.toHaveProperty('facts');
    });
  }

  it('facts item NOT scored when entityType is null', () => {
    const result = computePageCoverage(
      makeInput({ entityType: null, factCount: 10 }),
    );
    expect(result.items).not.toHaveProperty('facts');
  });

  it('facts item NOT scored when entityType is undefined', () => {
    const result = computePageCoverage(
      makeInput({ entityType: undefined, factCount: 10 }),
    );
    expect(result.items).not.toHaveProperty('facts');
  });

  it('factCount still passed through to output when entityType is concept', () => {
    const result = computePageCoverage(
      makeInput({ entityType: 'concept', factCount: 7 }),
    );
    // factCount is still stored in the output for informational use
    expect(result.factCount).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// computePageCoverage — ratio metrics (quotes, accuracy)
// ---------------------------------------------------------------------------

describe('computePageCoverage — ratio metrics', () => {
  it('quotes red when quotesTotal is 0', () => {
    const result = computePageCoverage(
      makeInput({ quotesWithQuotes: 0, quotesTotal: 0 }),
    );
    expect(result.items.quotes).toBe('red');
  });

  it('quotes green when quotesWithQuotes / quotesTotal >= 75%', () => {
    const result = computePageCoverage(
      makeInput({ quotesWithQuotes: 8, quotesTotal: 10 }),
    );
    expect(result.items.quotes).toBe('green');
  });

  it('quotes amber when quotesWithQuotes > 0 but ratio < 75%', () => {
    const result = computePageCoverage(
      makeInput({ quotesWithQuotes: 1, quotesTotal: 10 }),
    );
    expect(result.items.quotes).toBe('amber');
  });

  it('accuracy red when accuracyTotal is 0', () => {
    const result = computePageCoverage(
      makeInput({ accuracyChecked: 0, accuracyTotal: 0 }),
    );
    expect(result.items.accuracy).toBe('red');
  });

  it('accuracy green when accuracyChecked / accuracyTotal >= 75%', () => {
    const result = computePageCoverage(
      makeInput({ accuracyChecked: 10, accuracyTotal: 10 }),
    );
    expect(result.items.accuracy).toBe('green');
  });
});

// ---------------------------------------------------------------------------
// computePageCoverage — passing / total counts
// ---------------------------------------------------------------------------

describe('computePageCoverage — passing and total counts', () => {
  it('passing equals number of green items', () => {
    const result = computePageCoverage(
      makeInput({
        llmSummary: 'yes',
        updateFrequency: 14,
        hasEntity: true,
        changeHistoryCount: 1,
      }),
    );
    const greenCount = Object.values(result.items).filter((s) => s === 'green').length;
    expect(result.passing).toBe(greenCount);
  });

  it('total equals number of items', () => {
    const result = computePageCoverage(makeInput());
    expect(result.total).toBe(Object.keys(result.items).length);
  });

  it('all items green gives passing === total', () => {
    // 3000-word article: diagrams target = Math.max(0, round(3*0.4)) = 1, so provide 1 diagram.
    // tables = Math.max(1, round(3*4)) = 12, internalLinks = Math.max(3, round(3*8)) = 24,
    // externalLinks = Math.max(1, round(3*5)) = 15, footnotes = Math.max(2, round(3*3)) = 9,
    // references = Math.max(1, round(3*3)) = 9
    const result = computePageCoverage(
      makeInput({
        wordCount: 3000,
        contentFormat: 'article',
        llmSummary: 'summary',
        updateFrequency: 30,
        hasEntity: true,
        changeHistoryCount: 5,
        hasOverview: true,
        tableCount: 12,
        diagramCount: 1,
        internalLinks: 24,
        externalLinks: 15,
        footnoteCount: 9,
        resourceCount: 9,
        quotesWithQuotes: 8,
        quotesTotal: 10,
        accuracyChecked: 10,
        accuracyTotal: 10,
        entityType: undefined, // no facts item
      }),
    );
    expect(result.passing).toBe(result.total);
  });
});

// ---------------------------------------------------------------------------
// computePageCoverage — actuals passthrough
// ---------------------------------------------------------------------------

describe('computePageCoverage — actuals passthrough', () => {
  it('actuals reflect input values', () => {
    const result = computePageCoverage(
      makeInput({
        tableCount: 7,
        diagramCount: 2,
        internalLinks: 15,
        externalLinks: 9,
        footnoteCount: 6,
        resourceCount: 4,
        quotesWithQuotes: 3,
        quotesTotal: 5,
        accuracyChecked: 8,
        accuracyTotal: 10,
      }),
    );
    expect(result.actuals.tables).toBe(7);
    expect(result.actuals.diagrams).toBe(2);
    expect(result.actuals.internalLinks).toBe(15);
    expect(result.actuals.externalLinks).toBe(9);
    expect(result.actuals.footnotes).toBe(6);
    expect(result.actuals.references).toBe(4);
    expect(result.actuals.quotesWithQuotes).toBe(3);
    expect(result.actuals.quotesTotal).toBe(5);
    expect(result.actuals.accuracyChecked).toBe(8);
    expect(result.actuals.accuracyTotal).toBe(10);
  });

  it('output does NOT contain backlinkCount', () => {
    const result = computePageCoverage(makeInput());
    // PageCoverage type has no backlinkCount field — verify it's absent at runtime
    expect((result as Record<string, unknown>).backlinkCount).toBeUndefined();
    expect((result.actuals as Record<string, unknown>).backlinkCount).toBeUndefined();
    expect((result.items as Record<string, unknown>).backlinkCount).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// computePageCoverage — editHistoryCount passthrough
// ---------------------------------------------------------------------------

describe('computePageCoverage — editHistoryCount passthrough', () => {
  it('editHistoryCount is set when changeHistoryCount > 0', () => {
    const result = computePageCoverage(makeInput({ changeHistoryCount: 5 }));
    expect(result.editHistoryCount).toBe(5);
  });

  it('editHistoryCount is undefined when changeHistoryCount is 0', () => {
    const result = computePageCoverage(makeInput({ changeHistoryCount: 0 }));
    expect(result.editHistoryCount).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// computePageCoverage — factCount passthrough
// ---------------------------------------------------------------------------

describe('computePageCoverage — factCount passthrough', () => {
  it('factCount is set in output when provided', () => {
    const result = computePageCoverage(makeInput({ factCount: 3 }));
    expect(result.factCount).toBe(3);
  });

  it('factCount is undefined when not provided or zero', () => {
    const result = computePageCoverage(makeInput({ factCount: 0 }));
    expect(result.factCount).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// computePageCoverage — ratingsString
// ---------------------------------------------------------------------------

describe('computePageCoverage — ratingsString', () => {
  it('ratingsString is undefined when ratings is absent', () => {
    const result = computePageCoverage(makeInput({ ratings: undefined }));
    expect(result.ratingsString).toBeUndefined();
  });

  it('ratingsString is undefined when ratings is null', () => {
    const result = computePageCoverage(makeInput({ ratings: null }));
    expect(result.ratingsString).toBeUndefined();
  });

  it('ratingsString includes all four fields when all provided', () => {
    const result = computePageCoverage(
      makeInput({
        ratings: { novelty: 8, rigor: 7, actionability: 6, completeness: 9 },
      }),
    );
    expect(result.ratingsString).toBe('N:8 R:7 A:6 C:9');
  });

  it('ratingsString includes only provided fields', () => {
    const result = computePageCoverage(
      makeInput({ ratings: { novelty: 5, rigor: 7 } }),
    );
    expect(result.ratingsString).toBe('N:5 R:7');
  });

  it('ratingsString is undefined when ratings object has no set fields', () => {
    const result = computePageCoverage(makeInput({ ratings: {} }));
    expect(result.ratingsString).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// computePageCoverage — edge cases
// ---------------------------------------------------------------------------

describe('computePageCoverage — edge cases', () => {
  it('empty page: all zeros, no summary, no entity', () => {
    const result = computePageCoverage(
      makeInput({
        wordCount: 0,
        llmSummary: null,
        updateFrequency: null,
        hasEntity: false,
        changeHistoryCount: 0,
        tableCount: 0,
        diagramCount: 0,
        internalLinks: 0,
        externalLinks: 0,
        footnoteCount: 0,
        resourceCount: 0,
        quotesWithQuotes: 0,
        quotesTotal: 0,
        accuracyChecked: 0,
        accuracyTotal: 0,
      }),
    );
    expect(result.passing).toBe(0);
    expect(result.total).toBeGreaterThan(0);
    Object.values(result.items).forEach((status) => {
      expect(['red', 'amber']).toContain(status);
    });
  });

  it('person page with 0 facts and hasOverview undefined: facts scored, overview omitted', () => {
    const result = computePageCoverage(
      makeInput({
        contentFormat: 'article',
        entityType: 'person',
        factCount: 0,
        hasOverview: undefined,
      }),
    );
    expect(result.items).toHaveProperty('facts');
    expect(result.items.facts).toBe('red');
    expect(result.items).not.toHaveProperty('overview');
  });

  it('organization page: both facts and overview can be scored simultaneously', () => {
    const result = computePageCoverage(
      makeInput({
        contentFormat: 'article',
        entityType: 'organization',
        factCount: 6,
        hasOverview: true,
      }),
    );
    expect(result.items).toHaveProperty('facts');
    expect(result.items.facts).toBe('green');
    expect(result.items).toHaveProperty('overview');
    expect(result.items.overview).toBe('green');
  });

  it('index page with person entity: overview omitted, facts scored', () => {
    const result = computePageCoverage(
      makeInput({
        contentFormat: 'index',
        entityType: 'person',
        factCount: 3,
        hasOverview: true,
      }),
    );
    // index format excludes overview
    expect(result.items).not.toHaveProperty('overview');
    // person entity still scores facts
    expect(result.items).toHaveProperty('facts');
    expect(result.items.facts).toBe('amber');
  });

  it('total is consistent: no extra unknown keys', () => {
    const result = computePageCoverage(makeInput());
    const knownKeys = new Set([
      'llmSummary', 'schedule', 'entity', 'editHistory',
      'overview',
      'tables', 'diagrams', 'internalLinks', 'externalLinks', 'footnotes', 'references',
      'facts',
      'quotes', 'accuracy',
    ]);
    Object.keys(result.items).forEach((key) => {
      expect(knownKeys).toContain(key);
    });
  });
});
