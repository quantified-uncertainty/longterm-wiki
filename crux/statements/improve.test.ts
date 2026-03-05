import { describe, it, expect, vi } from 'vitest';
import { qualityGate, runIterativeLoop } from './improve.ts';
import type { PassResult, IterativeOptions, PassFn } from './improve.ts';
import type { ScoringStatement } from './scoring.ts';
import { CostTracker } from '../lib/cost-tracker.ts';

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
// Iterative loop helpers
// ---------------------------------------------------------------------------

function makePassResult(overrides: Partial<PassResult> = {}): PassResult {
  return {
    entityId: 'test-entity',
    entityType: 'organization',
    categoriesProcessed: ['safety'],
    coverageBefore: 0.3,
    coverageAfter: 0.5,
    created: 3,
    rejected: 1,
    totalCost: 0.1,
    rejections: [],
    ...overrides,
  };
}

function makeIterativeOptions(overrides: Partial<IterativeOptions> = {}): IterativeOptions {
  return {
    entityId: 'test-entity',
    orgType: null,
    categoryFilter: null,
    minScore: 0.5,
    budget: 10,
    noResearch: true,
    dryRun: false,
    client: {} as any,
    tracker: new CostTracker(),
    targetCoverage: 0.8,
    maxIterations: 5,
    ...overrides,
  };
}

/**
 * Build a mock pass function that returns the given results in sequence.
 */
function mockPassFn(results: PassResult[]): PassFn {
  let callIndex = 0;
  return vi.fn(async () => {
    if (callIndex >= results.length) {
      throw new Error(`mockPassFn: unexpected call ${callIndex + 1}, only ${results.length} results provided`);
    }
    return results[callIndex++];
  });
}

// ---------------------------------------------------------------------------
// Iterative loop tests
// ---------------------------------------------------------------------------

describe('runIterativeLoop', () => {
  it('stops when target coverage is reached', async () => {
    const passFn = mockPassFn([
      makePassResult({ coverageBefore: 0.3, coverageAfter: 0.5, created: 3 }),
      makePassResult({ coverageBefore: 0.5, coverageAfter: 0.7, created: 2 }),
      makePassResult({ coverageBefore: 0.7, coverageAfter: 0.85, created: 2 }),
    ]);

    const result = await runIterativeLoop(
      makeIterativeOptions({ targetCoverage: 0.8 }),
      passFn,
    );

    expect(result.converged).toBe(true);
    expect(result.stalled).toBe(false);
    expect(result.passes).toHaveLength(3);
    expect(result.finalCoverage).toBe(0.85);
    expect(result.totalCreated).toBe(7);
    expect(passFn).toHaveBeenCalledTimes(3);
  });

  it('stops when max iterations hit', async () => {
    const passFn = mockPassFn([
      makePassResult({ coverageBefore: 0.1, coverageAfter: 0.2, created: 2 }),
      makePassResult({ coverageBefore: 0.2, coverageAfter: 0.3, created: 2 }),
      makePassResult({ coverageBefore: 0.3, coverageAfter: 0.4, created: 2 }),
    ]);

    const result = await runIterativeLoop(
      makeIterativeOptions({ targetCoverage: 0.95, maxIterations: 3 }),
      passFn,
    );

    expect(result.converged).toBe(false);
    expect(result.stalled).toBe(false);
    expect(result.passes).toHaveLength(3);
    expect(result.finalCoverage).toBe(0.4);
    expect(result.totalCreated).toBe(6);
  });

  it('detects convergence when no statements are created', async () => {
    const passFn = mockPassFn([
      makePassResult({ coverageBefore: 0.3, coverageAfter: 0.5, created: 3 }),
      makePassResult({ coverageBefore: 0.5, coverageAfter: 0.5, created: 0, rejected: 0 }),
    ]);

    const result = await runIterativeLoop(
      makeIterativeOptions({ targetCoverage: 0.9 }),
      passFn,
    );

    expect(result.converged).toBe(false);
    expect(result.stalled).toBe(true);
    expect(result.passes).toHaveLength(2);
    expect(result.finalCoverage).toBe(0.5);
    expect(result.totalCreated).toBe(3);
    expect(result.totalRejected).toBe(1); // from first pass default
  });

  it('detects stall when coverage does not improve between passes', async () => {
    const passFn = mockPassFn([
      makePassResult({ coverageBefore: 0.3, coverageAfter: 0.5, created: 3 }),
      makePassResult({ coverageBefore: 0.5, coverageAfter: 0.5, created: 1 }),
    ]);

    const result = await runIterativeLoop(
      makeIterativeOptions({ targetCoverage: 0.9 }),
      passFn,
    );

    expect(result.converged).toBe(false);
    expect(result.stalled).toBe(true);
    expect(result.passes).toHaveLength(2);
  });

  it('stops when budget is exhausted', async () => {
    const tracker = new CostTracker();

    const passFn = vi.fn(async () => {
      // Simulate cost accumulation in the tracker
      tracker.recordExternalCost('test-model', 6, 'test');
      return makePassResult({ coverageBefore: 0.3, coverageAfter: 0.5, created: 3 });
    });

    const result = await runIterativeLoop(
      makeIterativeOptions({ targetCoverage: 0.95, budget: 10, tracker }),
      passFn,
    );

    // First pass spends $6, then budget check: $6 < $10, so second pass runs and
    // spends another $6 ($12 total). Third pass: $12 >= $10, so loop stops.
    expect(result.passes).toHaveLength(2);
    expect(result.converged).toBe(false);
  });

  it('aggregates totals across all passes', async () => {
    const passFn = mockPassFn([
      makePassResult({ coverageBefore: 0.3, coverageAfter: 0.5, created: 3, rejected: 2 }),
      makePassResult({ coverageBefore: 0.5, coverageAfter: 0.85, created: 4, rejected: 1 }),
    ]);

    const result = await runIterativeLoop(
      makeIterativeOptions({ targetCoverage: 0.8 }),
      passFn,
    );

    expect(result.totalCreated).toBe(7);
    expect(result.totalRejected).toBe(3);
    expect(result.passes).toHaveLength(2);
  });

  it('handles single pass convergence (target met on first try)', async () => {
    const passFn = mockPassFn([
      makePassResult({ coverageBefore: 0.3, coverageAfter: 0.9, created: 5 }),
    ]);

    const result = await runIterativeLoop(
      makeIterativeOptions({ targetCoverage: 0.8 }),
      passFn,
    );

    expect(result.converged).toBe(true);
    expect(result.stalled).toBe(false);
    expect(result.passes).toHaveLength(1);
    expect(result.finalCoverage).toBe(0.9);
    expect(passFn).toHaveBeenCalledTimes(1);
  });

  it('uses coverageBefore when coverageAfter is null (dry-run)', async () => {
    const passFn = mockPassFn([
      makePassResult({ coverageBefore: 0.3, coverageAfter: null, created: 0 }),
    ]);

    const result = await runIterativeLoop(
      makeIterativeOptions({ targetCoverage: 0.8 }),
      passFn,
    );

    // coverageAfter is null, so finalCoverage = coverageBefore = 0.3
    // created is 0, so stalled = true
    expect(result.stalled).toBe(true);
    expect(result.finalCoverage).toBe(0.3);
  });
});
