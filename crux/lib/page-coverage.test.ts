import { describe, it, expect } from 'vitest';
import {
  computePageCoverage,
  getRecommendedTargets,
  getMetricStatus,
  getRatioStatus,
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
// getMetricStatus
// ---------------------------------------------------------------------------

describe('getMetricStatus', () => {
  it.each([
    [5, 5, 'green'],
    [10, 5, 'green'],
    [2, 5, 'amber'],
    [1, 10, 'amber'],
    [0, 5, 'red'],
    [1, 0, 'green'],
    [0, 0, 'red'],
    [3, undefined, 'green'],
    [0, undefined, 'red'],
  ] as const)('getMetricStatus(%i, %s) => %s', (actual, target, expected) => {
    expect(getMetricStatus(actual, target)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// getRatioStatus
// ---------------------------------------------------------------------------

describe('getRatioStatus', () => {
  it.each([
    [0, 0, 'red'],
    [5, 0, 'red'],
    [75, 100, 'green'],
    [10, 10, 'green'],
    [4, 5, 'green'],    // 80%
    [1, 100, 'amber'],
    [74, 100, 'amber'],
    [0, 10, 'red'],
  ] as const)('getRatioStatus(%i, %i) => %s', (num, denom, expected) => {
    expect(getRatioStatus(num, denom)).toBe(expected);
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
  it.each([
    ['llmSummary', { llmSummary: 'Summary text' }, 'green'],
    ['llmSummary', { llmSummary: null }, 'red'],
    ['schedule', { updateFrequency: 14 }, 'green'],
    ['schedule', { updateFrequency: null }, 'red'],
    ['entity', { hasEntity: true }, 'green'],
    ['entity', { hasEntity: false }, 'red'],
    ['editHistory', { changeHistoryCount: 3 }, 'green'],
    ['editHistory', { changeHistoryCount: 0 }, 'red'],
  ] as const)('%s is %s when override applied', (itemKey, overrides, expected) => {
    const result = computePageCoverage(makeInput(overrides as Partial<CoverageInput>));
    expect(result.items[itemKey as keyof typeof result.items]).toBe(expected);
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
    expect((result as unknown as Record<string, unknown>).backlinkCount).toBeUndefined();
    expect((result.actuals as unknown as Record<string, unknown>).backlinkCount).toBeUndefined();
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

  it('total is consistent: no extra unknown keys', () => {
    const result = computePageCoverage(makeInput());
    const knownKeys = new Set([
      'llmSummary', 'schedule', 'entity', 'editHistory',
      'overview',
      'tables', 'diagrams', 'internalLinks', 'externalLinks', 'footnotes', 'references',
      'quotes', 'accuracy',
    ]);
    Object.keys(result.items).forEach((key) => {
      expect(knownKeys).toContain(key);
    });
  });
});
