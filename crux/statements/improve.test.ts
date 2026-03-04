import { describe, it, expect } from 'vitest';
import { qualityGate, qualityGateRewrite, toScoringStatement } from './improve.ts';
import type { GeneratedStatement } from './improve.ts';
import type { ScoringStatement } from './scoring.ts';

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
// Quality gate
// ---------------------------------------------------------------------------

describe('qualityGate', () => {
  const entityId = 'anthropic';
  const entityName = 'Anthropic';

  it('accepts a well-formed statement above threshold', () => {
    const existingSiblings = [makeStmt({ id: 1 })];
    const generated = [
      {
        statementText: 'Anthropic was founded in 2021 by Dario and Daniela Amodei.',
        propertyId: 'founding-date',
        variety: 'structured' as const,
        validStart: '2021',
      },
    ];

    const result = qualityGate(generated, entityId, entityName, existingSiblings, 0.3);
    expect(result.accepted.length).toBe(1);
    expect(result.rejected.length).toBe(0);
    expect(result.accepted[0].statementText).toBe(generated[0].statementText);
    expect(result.accepted[0].subjectEntityId).toBe(entityId);
  });

  it('rejects near-duplicate statements', () => {
    const existingSiblings = [
      makeStmt({
        id: 1,
        statementText: 'Anthropic raised $7.3 billion in a Series E funding round in 2024.',
      }),
    ];
    const generated = [
      {
        statementText: 'Anthropic raised $7.3 billion in a Series E round in 2024.',
        propertyId: 'funding-round-amount',
        variety: 'structured' as const,
      },
    ];

    const result = qualityGate(generated, entityId, entityName, existingSiblings, 0.3);
    expect(result.rejected.length).toBe(1);
    expect(result.rejected[0].reason).toContain('Near-duplicate');
  });

  it('rejects statements below the quality threshold', () => {
    const existingSiblings: ScoringStatement[] = [];
    const generated = [
      {
        statementText: 'Bad.',  // Too short, no entity mention, no structure
        propertyId: 'unknown',
        variety: 'structured' as const,
      },
    ];

    const result = qualityGate(generated, entityId, entityName, existingSiblings, 0.8);
    expect(result.rejected.length).toBe(1);
    expect(result.rejected[0].reason).toContain('Below quality threshold');
  });

  it('checks uniqueness against previously accepted candidates', () => {
    const existingSiblings: ScoringStatement[] = [];
    const generated = [
      {
        statementText: 'Anthropic is an AI safety company based in San Francisco, California.',
        propertyId: 'headquarters-location',
        variety: 'structured' as const,
        valueText: 'San Francisco, California',
      },
      {
        statementText: 'Anthropic is an AI safety company based in San Francisco, California.',
        propertyId: 'headquarters-location',
        variety: 'structured' as const,
        valueText: 'San Francisco, California',
      },
    ];

    const result = qualityGate(generated, entityId, entityName, existingSiblings, 0.3);
    // First should be accepted, second should be rejected as duplicate
    expect(result.accepted.length).toBe(1);
    expect(result.rejected.length).toBe(1);
    expect(result.rejected[0].reason).toContain('Near-duplicate');
  });

  it('returns empty results for empty input', () => {
    const result = qualityGate([], entityId, entityName, [], 0.5);
    expect(result.accepted.length).toBe(0);
    expect(result.rejected.length).toBe(0);
  });

  it('preserves citation data in accepted statements', () => {
    const generated = [
      {
        statementText: 'Anthropic published their Responsible Scaling Policy in September 2023.',
        propertyId: 'safety-policy',
        variety: 'structured' as const,
        validStart: '2023-09',
        citations: [
          { url: 'https://example.com/rsp', sourceQuote: 'Responsible Scaling Policy' },
        ],
      },
    ];

    const result = qualityGate(generated, entityId, entityName, [], 0.3);
    expect(result.accepted.length).toBe(1);
    expect(result.accepted[0].citations).toHaveLength(1);
    expect(result.accepted[0].citations![0].url).toBe('https://example.com/rsp');
  });
});

// ---------------------------------------------------------------------------
// toScoringStatement
// ---------------------------------------------------------------------------

describe('toScoringStatement', () => {
  it('converts a by-entity API response to a ScoringStatement', () => {
    const apiRow = {
      id: 42,
      variety: 'structured',
      statementText: 'Anthropic has over 1000 employees.',
      subjectEntityId: 'anthropic',
      propertyId: 'employee-count',
      valueNumeric: '1000' as unknown as number, // API may return strings for numeric values
      valueUnit: 'employees',
      valueText: null,
      valueEntityId: null,
      valueDate: null,
      validStart: '2024',
      validEnd: null,
      status: 'active',
      claimCategory: null,
      property: { id: 'employee-count', label: 'Employee Count', category: 'organizational' },
      citations: [{ url: 'https://example.com', sourceQuote: 'over 1000 employees' }],
    };

    const result = toScoringStatement(apiRow);

    expect(result.id).toBe(42);
    expect(result.valueNumeric).toBe(1000); // string converted to number
    expect(result.property?.category).toBe('organizational');
    expect(result.citations).toHaveLength(1);
    expect(result.citations?.[0].url).toBe('https://example.com');
  });

  it('handles null property and missing citations', () => {
    const apiRow = {
      id: 1,
      variety: 'attributed',
      statementText: 'Some statement.',
      subjectEntityId: 'test',
      propertyId: null,
      valueNumeric: null,
      valueUnit: null,
      valueText: null,
      valueEntityId: null,
      valueDate: null,
      validStart: null,
      validEnd: null,
      status: 'active',
      claimCategory: null,
    };

    const result = toScoringStatement(apiRow);
    expect(result.property).toBeNull();
    expect(result.citations).toBeUndefined();
  });

  it('handles numeric valueNumeric correctly', () => {
    const apiRow = {
      id: 5,
      variety: 'structured',
      statementText: 'Test statement.',
      subjectEntityId: 'test',
      propertyId: 'p1',
      valueNumeric: 42.5,
      valueUnit: 'units',
      valueText: null,
      valueEntityId: null,
      valueDate: null,
      validStart: null,
      validEnd: null,
      status: 'active',
      claimCategory: null,
    };

    const result = toScoringStatement(apiRow);
    expect(result.valueNumeric).toBe(42.5);
  });
});

// ---------------------------------------------------------------------------
// qualityGateRewrite — accepts rewrites that score higher than originals
// ---------------------------------------------------------------------------

describe('qualityGateRewrite', () => {
  const entityId = 'anthropic';
  const entityName = 'Anthropic';
  const propertyMap = new Map<string, { id: string; label: string; category: string; stalenessCadence?: string | null }>([
    ['founding-date', { id: 'founding-date', label: 'Founding Date', category: 'organizational', stalenessCadence: null }],
    ['funding-round-amount', { id: 'funding-round-amount', label: 'Funding Round Amount', category: 'financial', stalenessCadence: null }],
    ['safety-policy', { id: 'safety-policy', label: 'Safety Policy', category: 'safety', stalenessCadence: null }],
  ]);

  it('accepts a rewrite that scores higher than the original', () => {
    const siblings = [makeStmt({ id: 100 })];

    // A well-structured rewrite with citations should score well
    const rewrite: GeneratedStatement = {
      statementText: 'Anthropic was founded in 2021 by Dario Amodei and Daniela Amodei.',
      propertyId: 'founding-date',
      variety: 'structured',
      valueNumeric: 2021,
      valueUnit: 'year',
      validStart: '2021',
      citations: [
        { url: 'https://en.wikipedia.org/wiki/Anthropic', sourceQuote: 'Founded in 2021 by Dario Amodei' },
      ],
    };

    // Use a very low original score so the rewrite should beat it
    const result = qualityGateRewrite(rewrite, 0.1, entityId, entityName, siblings, propertyMap);
    expect(result.accepted).toBe(true);
    expect(result.newScore).toBeGreaterThan(0.1);
    expect(result.reason).toContain('Improved');
  });

  it('rejects a rewrite that does not improve on the original score', () => {
    const siblings = [makeStmt({ id: 100 })];

    // A low-quality rewrite — vague, no citations, no structure
    const badRewrite: GeneratedStatement = {
      statementText: 'Some things happened at Anthropic.',
      propertyId: 'funding-round-amount',
      variety: 'attributed',
    };

    // Use a high original score so the bad rewrite cannot beat it
    const result = qualityGateRewrite(badRewrite, 0.9, entityId, entityName, siblings, propertyMap);
    expect(result.accepted).toBe(false);
    expect(result.newScore).toBeLessThanOrEqual(0.9);
    expect(result.reason).toContain('did not improve');
  });

  it('rejects a rewrite that exactly matches the original score (strict improvement required)', () => {
    const siblings: ScoringStatement[] = [];

    const rewrite: GeneratedStatement = {
      statementText: 'Anthropic was founded in 2021.',
      propertyId: 'founding-date',
      variety: 'structured',
      valueNumeric: 2021,
      validStart: '2021',
      citations: [{ url: 'https://example.com', sourceQuote: 'test' }],
    };

    // Score the rewrite to find its score, then use that exact value as the original score
    const probe = qualityGateRewrite(rewrite, 999, entityId, entityName, siblings, propertyMap);
    const rewriteScore = probe.newScore;

    // Now test with originalScore = rewriteScore (should be rejected: not strictly greater)
    const result = qualityGateRewrite(rewrite, rewriteScore, entityId, entityName, siblings, propertyMap);
    expect(result.accepted).toBe(false);
  });

  it('returns the new score in both accept and reject cases', () => {
    const siblings: ScoringStatement[] = [];

    const rewrite: GeneratedStatement = {
      statementText: 'Anthropic published their Responsible Scaling Policy in September 2023.',
      propertyId: 'safety-policy',
      variety: 'structured',
      validStart: '2023-09',
      citations: [{ url: 'https://example.com/rsp', sourceQuote: 'RSP published September 2023' }],
    };

    const accepted = qualityGateRewrite(rewrite, 0.05, entityId, entityName, siblings, propertyMap);
    expect(typeof accepted.newScore).toBe('number');
    expect(accepted.newScore).toBeGreaterThan(0);

    const rejected = qualityGateRewrite(rewrite, 0.99, entityId, entityName, siblings, propertyMap);
    expect(typeof rejected.newScore).toBe('number');
    expect(rejected.newScore).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Quality-pass filtering logic (unit-level logic without network calls)
// ---------------------------------------------------------------------------

describe('quality-pass filtering logic', () => {
  it('correctly identifies low-quality statements below threshold', () => {
    const scores = [
      { statementId: 1, qualityScore: 0.2 },
      { statementId: 2, qualityScore: 0.5 },
      { statementId: 3, qualityScore: 0.8 },
      { statementId: 4, qualityScore: 0.35 },
    ];

    const minScore = 0.4;
    const lowQuality = scores.filter((s) => s.qualityScore < minScore);

    expect(lowQuality).toHaveLength(2);
    expect(lowQuality.map((s) => s.statementId)).toEqual([1, 4]);
  });

  it('filters by category when categoryFilter is specified', () => {
    const scores = [
      { statementId: 1, qualityScore: 0.2 },
      { statementId: 2, qualityScore: 0.3 },
      { statementId: 3, qualityScore: 0.1 },
    ];

    const stmts: ScoringStatement[] = [
      makeStmt({ id: 1, property: { id: 'p1', label: 'P1', category: 'safety', stalenessCadence: null } }),
      makeStmt({ id: 2, property: { id: 'p2', label: 'P2', category: 'financial', stalenessCadence: null } }),
      makeStmt({ id: 3, property: { id: 'p3', label: 'P3', category: 'safety', stalenessCadence: null } }),
    ];

    const categoryFilter = 'safety';
    const filtered = scores.filter((s) => {
      const stmt = stmts.find((st) => st.id === s.statementId);
      return stmt?.property?.category === categoryFilter;
    });

    expect(filtered).toHaveLength(2);
    expect(filtered.map((s) => s.statementId)).toEqual([1, 3]);
  });

  it('returns empty when all statements are above threshold', () => {
    const scores = [
      { statementId: 1, qualityScore: 0.6 },
      { statementId: 2, qualityScore: 0.8 },
    ];

    const minScore = 0.4;
    const lowQuality = scores.filter((s) => s.qualityScore < minScore);

    expect(lowQuality).toHaveLength(0);
  });
});
