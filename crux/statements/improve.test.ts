import { describe, it, expect } from 'vitest';
import { qualityGate } from './improve.ts';
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
