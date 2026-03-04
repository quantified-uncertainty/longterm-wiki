import { describe, it, expect } from 'vitest';
import {
  scoreStructure,
  scorePrecision,
  scoreClarity,
  scoreResolvability,
  scoreUniqueness,
  scoreAtomicity,
  scoreRecency,
  scoreNeglectedness,
  scoreCrossEntityUtility,
  scoreImportance,
  scoreStatement,
  scoreAllStatements,
  type ScoringStatement,
} from './scoring.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeStmt(overrides: Partial<ScoringStatement> = {}): ScoringStatement {
  return {
    id: 1,
    variety: 'structured',
    statementText: 'Anthropic raised $7.3 billion in a Series E funding round in 2024.',
    subjectEntityId: 'anthropic',
    propertyId: 'funding-round-amount',
    valueNumeric: 7300000000,
    valueUnit: 'USD',
    valueText: null,
    valueEntityId: null,
    valueDate: null,
    validStart: '2024',
    validEnd: null,
    status: 'active',
    claimCategory: 'factual',
    citations: [],
    property: {
      id: 'funding-round-amount',
      label: 'Funding Round Amount',
      category: 'financial',
      stalenessCadence: null,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

describe('scoreStructure', () => {
  it('returns 1.0 for property + value + unit', () => {
    expect(scoreStructure(makeStmt())).toBe(1.0);
  });

  it('returns 0.75 for property + value without unit', () => {
    expect(scoreStructure(makeStmt({ valueUnit: null }))).toBe(0.75);
  });

  it('returns 0.5 for property only', () => {
    expect(scoreStructure(makeStmt({
      valueNumeric: null, valueUnit: null, valueText: null,
      valueEntityId: null, valueDate: null,
    }))).toBe(0.5);
  });

  it('returns 0.0 for text-only (no property)', () => {
    expect(scoreStructure(makeStmt({ propertyId: null }))).toBe(0.0);
  });

  it('recognizes valueText as a value', () => {
    expect(scoreStructure(makeStmt({
      valueNumeric: null, valueText: 'Sam Altman', valueUnit: null,
    }))).toBe(0.75);
  });

  it('recognizes valueEntityId as a value', () => {
    expect(scoreStructure(makeStmt({
      valueNumeric: null, valueEntityId: 'sam-altman', valueUnit: null,
    }))).toBe(0.75);
  });
});

// ---------------------------------------------------------------------------
// Precision
// ---------------------------------------------------------------------------

describe('scorePrecision', () => {
  it('scores high for numeric specifics', () => {
    const score = scorePrecision(makeStmt());
    expect(score).toBeGreaterThanOrEqual(0.8);
  });

  it('scores low for vague text without numbers', () => {
    const score = scorePrecision(makeStmt({
      statementText: 'Anthropic has made significant investments in safety research.',
      valueNumeric: null,
    }));
    expect(score).toBeLessThanOrEqual(0.5);
  });

  it('returns 0 for empty text', () => {
    expect(scorePrecision(makeStmt({ statementText: '' }))).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// Clarity
// ---------------------------------------------------------------------------

describe('scoreClarity', () => {
  it('scores high for self-contained, well-formed statement', () => {
    const score = scoreClarity(
      makeStmt({ statementText: 'Anthropic raised $7.3 billion in a Series E funding round.' }),
      'anthropic',
      'Anthropic',
    );
    expect(score).toBeGreaterThanOrEqual(0.8);
  });

  it('scores lower when entity name is missing', () => {
    const score = scoreClarity(
      makeStmt({ statementText: 'Raised $7.3 billion in a Series E funding round.' }),
      'anthropic',
      'Anthropic',
    );
    expect(score).toBeLessThan(
      scoreClarity(
        makeStmt({ statementText: 'Anthropic raised $7.3 billion in a Series E funding round.' }),
        'anthropic',
        'Anthropic',
      ),
    );
  });

  it('returns 0 for empty text', () => {
    expect(scoreClarity(makeStmt({ statementText: '' }), 'anthropic', 'Anthropic')).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// Resolvability
// ---------------------------------------------------------------------------

describe('scoreResolvability', () => {
  it('returns 1.0 for citation + URL + sourceQuote', () => {
    const score = scoreResolvability(makeStmt({
      citations: [{
        resourceId: 'techcrunch-anthropic-2024',
        url: 'https://techcrunch.com/anthropic',
        sourceQuote: 'Anthropic raised $7.3B',
      }],
    }));
    expect(score).toBe(1.0);
  });

  it('returns 0.66 for citation + URL without sourceQuote', () => {
    const score = scoreResolvability(makeStmt({
      citations: [{
        resourceId: null,
        url: 'https://techcrunch.com/anthropic',
        sourceQuote: null,
      }],
    }));
    expect(score).toBeCloseTo(0.66, 1);
  });

  it('returns 0.33 for citation without URL or sourceQuote', () => {
    const score = scoreResolvability(makeStmt({
      citations: [{
        resourceId: null,
        url: null,
        sourceQuote: null,
      }],
    }));
    expect(score).toBeCloseTo(0.33, 1);
  });

  it('returns 0.0 for no citations', () => {
    expect(scoreResolvability(makeStmt({ citations: [] }))).toBe(0.0);
  });

  it('takes the best citation score', () => {
    const score = scoreResolvability(makeStmt({
      citations: [
        { resourceId: null, url: null, sourceQuote: null },
        { resourceId: 'res-1', url: 'https://example.com', sourceQuote: 'quote' },
      ],
    }));
    expect(score).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Uniqueness
// ---------------------------------------------------------------------------

describe('scoreUniqueness', () => {
  it('returns 1.0 for a unique statement', () => {
    const stmt = makeStmt({ id: 1 });
    const sibling = makeStmt({
      id: 2,
      statementText: 'DeepMind published AlphaFold in 2020.',
    });
    const score = scoreUniqueness(stmt, [stmt, sibling]);
    expect(score).toBeGreaterThanOrEqual(0.8);
  });

  it('scores low for near-duplicate', () => {
    const stmt = makeStmt({ id: 1, statementText: 'Anthropic raised $7.3 billion in funding.' });
    const dup = makeStmt({ id: 2, statementText: 'Anthropic raised $7.3 billion in a funding round.' });
    const score = scoreUniqueness(stmt, [stmt, dup]);
    expect(score).toBeLessThanOrEqual(0.5);
  });

  it('returns 0 for empty text', () => {
    expect(scoreUniqueness(makeStmt({ statementText: '' }), [])).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// Atomicity
// ---------------------------------------------------------------------------

describe('scoreAtomicity', () => {
  it('returns 1.0 for a single fact', () => {
    expect(scoreAtomicity(makeStmt())).toBe(1.0);
  });

  it('returns 0.0 for semicolon-split facts', () => {
    expect(scoreAtomicity(makeStmt({
      statementText: 'Anthropic raised $7.3B; OpenAI raised $6.6B.',
    }))).toBe(0.0);
  });

  it('returns 0.0 for compound conjunction', () => {
    expect(scoreAtomicity(makeStmt({
      statementText: 'Anthropic raised $7.3B, and Google invested $2B.',
    }))).toBe(0.0);
  });

  it('returns 0.0 for connective adverbs', () => {
    expect(scoreAtomicity(makeStmt({
      statementText: 'Anthropic raised $7.3B. Additionally, they expanded to London.',
    }))).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// Recency
// ---------------------------------------------------------------------------

describe('scoreRecency', () => {
  const now = new Date('2026-03-04');

  it('returns 1.0 for evergreen facts (no cadence)', () => {
    expect(scoreRecency(makeStmt(), now)).toBe(1.0);
  });

  it('returns high score for recent quarterly data', () => {
    const stmt = makeStmt({
      validStart: '2026-01',
      property: { id: 'revenue', label: 'Revenue', category: 'financial', stalenessCadence: 'quarterly' },
    });
    const score = scoreRecency(stmt, now);
    expect(score).toBeGreaterThanOrEqual(0.8);
  });

  it('returns low score for stale data', () => {
    const stmt = makeStmt({
      validStart: '2023-01',
      property: { id: 'revenue', label: 'Revenue', category: 'financial', stalenessCadence: 'quarterly' },
    });
    const score = scoreRecency(stmt, now);
    expect(score).toBeLessThanOrEqual(0.2);
  });

  it('returns 0.3 when no validStart for temporal data', () => {
    const stmt = makeStmt({
      validStart: null,
      property: { id: 'revenue', label: 'Revenue', category: 'financial', stalenessCadence: 'annually' },
    });
    expect(scoreRecency(stmt, now)).toBe(0.3);
  });
});

// ---------------------------------------------------------------------------
// Neglectedness
// ---------------------------------------------------------------------------

describe('scoreNeglectedness', () => {
  it('scores high for underrepresented category', () => {
    const safetyStmt = makeStmt({
      id: 1,
      property: { id: 'safety-policy', label: 'Safety Policy', category: 'safety' },
    });
    const financialStmts = Array.from({ length: 10 }, (_, i) => makeStmt({
      id: i + 2,
      property: { id: 'revenue', label: 'Revenue', category: 'financial' },
    }));
    const siblings = [safetyStmt, ...financialStmts];

    const score = scoreNeglectedness(safetyStmt, siblings);
    expect(score).toBeGreaterThanOrEqual(0.8);
  });

  it('scores low for overrepresented category', () => {
    const financialStmt = makeStmt({
      id: 1,
      property: { id: 'revenue', label: 'Revenue', category: 'financial' },
    });
    const financialStmts = Array.from({ length: 10 }, (_, i) => makeStmt({
      id: i + 2,
      property: { id: 'valuation', label: 'Valuation', category: 'financial' },
    }));
    const safetyStmt = makeStmt({
      id: 12,
      property: { id: 'safety-policy', label: 'Safety Policy', category: 'safety' },
    });
    const siblings = [financialStmt, ...financialStmts, safetyStmt];

    const score = scoreNeglectedness(financialStmt, siblings);
    expect(score).toBeLessThanOrEqual(0.5);
  });
});

// ---------------------------------------------------------------------------
// Cross-entity utility
// ---------------------------------------------------------------------------

describe('scoreCrossEntityUtility', () => {
  it('returns 1.0 when valueEntityId is set', () => {
    expect(scoreCrossEntityUtility(makeStmt({ valueEntityId: 'google' }))).toBe(1.0);
  });

  it('returns 0.8 for relation property', () => {
    expect(scoreCrossEntityUtility(makeStmt({
      valueEntityId: null,
      property: { id: 'parent-org', label: 'Parent Org', category: 'relation' },
    }))).toBe(0.8);
  });

  it('returns 0.0 for self-contained statement', () => {
    expect(scoreCrossEntityUtility(makeStmt({
      valueEntityId: null,
      statementText: 'Revenue was $100M.',
      property: { id: 'revenue', label: 'Revenue', category: 'financial' },
    }))).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// Importance
// ---------------------------------------------------------------------------

describe('scoreImportance', () => {
  it('scores high for safety category', () => {
    const score = scoreImportance(makeStmt({
      property: { id: 'safety-policy', label: 'Safety Policy', category: 'safety' },
    }));
    expect(score).toBe(0.95);
  });

  it('returns default for unknown category', () => {
    const score = scoreImportance(makeStmt({
      property: { id: 'custom', label: 'Custom', category: 'unknown-category' },
    }));
    expect(score).toBe(0.5);
  });

  it('returns default when no property', () => {
    expect(scoreImportance(makeStmt({ property: null }))).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Composite scoring
// ---------------------------------------------------------------------------

describe('scoreStatement', () => {
  it('computes composite score as weighted average', () => {
    const stmt = makeStmt({
      citations: [{
        resourceId: 'techcrunch-anthropic-2024',
        url: 'https://techcrunch.com/anthropic',
        sourceQuote: 'Anthropic raised $7.3B',
      }],
    });
    const result = scoreStatement(stmt, {
      siblings: [stmt],
      entityId: 'anthropic',
      entityName: 'Anthropic',
    });

    expect(result.statementId).toBe(1);
    expect(result.qualityScore).toBeGreaterThan(0);
    expect(result.qualityScore).toBeLessThanOrEqual(1);
    expect(result.dimensions).toHaveProperty('structure');
    expect(result.dimensions).toHaveProperty('precision');
    expect(result.dimensions).toHaveProperty('clarity');
    expect(result.dimensions).toHaveProperty('resolvability');
    expect(result.dimensions).toHaveProperty('uniqueness');
    expect(result.dimensions).toHaveProperty('atomicity');
    expect(result.dimensions).toHaveProperty('importance');
    expect(result.dimensions).toHaveProperty('neglectedness');
    expect(result.dimensions).toHaveProperty('recency');
    expect(result.dimensions).toHaveProperty('crossEntityUtility');
  });

  it('high-quality statement scores > 0.7', () => {
    const stmt = makeStmt({
      citations: [{
        resourceId: 'tc-2024',
        url: 'https://techcrunch.com',
        sourceQuote: 'Quote here',
      }],
    });
    const result = scoreStatement(stmt, {
      siblings: [stmt],
      entityId: 'anthropic',
      entityName: 'Anthropic',
    });
    expect(result.qualityScore).toBeGreaterThan(0.6);
  });

  it('low-quality statement scores < 0.4', () => {
    const stmt = makeStmt({
      propertyId: null,
      statementText: 'Stuff.',
      valueNumeric: null,
      valueUnit: null,
      citations: [],
      property: null,
    });
    const result = scoreStatement(stmt, {
      siblings: [stmt],
      entityId: 'anthropic',
      entityName: 'Anthropic',
    });
    expect(result.qualityScore).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// Batch scoring
// ---------------------------------------------------------------------------

describe('scoreAllStatements', () => {
  it('scores all statements and returns correct count', () => {
    const stmts = [
      makeStmt({ id: 1 }),
      makeStmt({ id: 2, statementText: 'DeepMind published AlphaFold in 2020.' }),
    ];
    const results = scoreAllStatements(stmts, 'anthropic', 'Anthropic');
    expect(results).toHaveLength(2);
    expect(results[0].statementId).toBe(1);
    expect(results[1].statementId).toBe(2);
  });

  it('handles empty array', () => {
    const results = scoreAllStatements([], 'test', 'Test');
    expect(results).toHaveLength(0);
  });
});
