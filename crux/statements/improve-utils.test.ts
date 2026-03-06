/**
 * Tests for utility functions in statements/improve.ts not covered by improve.test.ts.
 *
 * Covers:
 *   - buildPropertyMap: converts property array to a lookup Map
 *   - buildScoringContext: converts GapAnalysis to scoring structures
 *
 * These are pure data-transform functions with no external dependencies.
 */

import { describe, it, expect } from 'vitest';
import { buildPropertyMap, buildScoringContext } from './improve.ts';
import type { GapAnalysis } from './gaps.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGapAnalysis(overrides: Partial<GapAnalysis> = {}): GapAnalysis {
  return {
    entityType: 'organization',
    totalStatements: 0,
    coverageScore: 0,
    gaps: [],
    categoryCounts: {},
    allStatements: [],
    propertyMap: new Map(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildPropertyMap
// ---------------------------------------------------------------------------

describe('buildPropertyMap', () => {
  it('creates a Map from an array of properties', () => {
    const props = [
      { id: 'founded-date', label: 'Founded Date', category: 'milestone', stalenessCadence: null },
      { id: 'employee-count', label: 'Employee Count', category: 'organizational', stalenessCadence: 'annually' },
    ];

    const map = buildPropertyMap(props);

    expect(map.size).toBe(2);
    expect(map.has('founded-date')).toBe(true);
    expect(map.has('employee-count')).toBe(true);
  });

  it('preserves all fields in each map entry', () => {
    const props = [
      { id: 'revenue', label: 'Annual Revenue', category: 'financial', stalenessCadence: 'annually' },
    ];

    const map = buildPropertyMap(props);
    const entry = map.get('revenue');

    expect(entry).toBeDefined();
    expect(entry!.id).toBe('revenue');
    expect(entry!.label).toBe('Annual Revenue');
    expect(entry!.category).toBe('financial');
    expect(entry!.stalenessCadence).toBe('annually');
  });

  it('handles null stalenessCadence', () => {
    const props = [
      { id: 'description', label: 'Description', category: 'general', stalenessCadence: null },
    ];

    const map = buildPropertyMap(props);
    expect(map.get('description')!.stalenessCadence).toBeNull();
  });

  it('returns an empty Map for an empty array', () => {
    const map = buildPropertyMap([]);
    expect(map.size).toBe(0);
  });

  it('handles duplicate IDs by keeping the last entry (Map semantics)', () => {
    const props = [
      { id: 'dup', label: 'First', category: 'a', stalenessCadence: null },
      { id: 'dup', label: 'Second', category: 'b', stalenessCadence: null },
    ];

    const map = buildPropertyMap(props);
    // Map.set overwrites — second value wins
    expect(map.size).toBe(1);
    expect(map.get('dup')!.label).toBe('Second');
  });

  it('uses property id as the Map key', () => {
    const props = [
      { id: 'my-property-id', label: 'My Property', category: 'test', stalenessCadence: null },
    ];

    const map = buildPropertyMap(props);
    expect(map.get('my-property-id')).toBeDefined();
    expect(map.get('My Property')).toBeUndefined(); // label is not the key
  });
});

// ---------------------------------------------------------------------------
// buildScoringContext
// ---------------------------------------------------------------------------

describe('buildScoringContext', () => {
  it('returns empty structures for an analysis with no statements', () => {
    const analysis = makeGapAnalysis();

    const { existingByCategory, existingScoringStmts } = buildScoringContext(analysis, 'test-entity');

    expect(existingByCategory.size).toBe(0);
    expect(existingScoringStmts).toHaveLength(0);
  });

  it('groups statement texts by category', () => {
    const analysis = makeGapAnalysis({
      allStatements: [
        { id: 1, variety: 'structured', statementText: 'Statement A', subjectEntityId: 'org', propertyId: 'prop-1', status: 'active' },
        { id: 2, variety: 'structured', statementText: 'Statement B', subjectEntityId: 'org', propertyId: 'prop-1', status: 'active' },
        { id: 3, variety: 'structured', statementText: 'Statement C', subjectEntityId: 'org', propertyId: 'prop-2', status: 'active' },
      ],
      propertyMap: new Map([
        ['prop-1', { category: 'financial' }],
        ['prop-2', { category: 'organizational' }],
      ]),
    });

    const { existingByCategory } = buildScoringContext(analysis, 'org');

    expect(existingByCategory.get('financial')).toEqual(['Statement A', 'Statement B']);
    expect(existingByCategory.get('organizational')).toEqual(['Statement C']);
  });

  it('assigns uncategorized category when property is unknown', () => {
    const analysis = makeGapAnalysis({
      allStatements: [
        { id: 1, variety: 'structured', statementText: 'Orphan statement', subjectEntityId: 'org', propertyId: 'unknown-prop', status: 'active' },
      ],
      propertyMap: new Map(), // empty — no property definitions
    });

    const { existingByCategory } = buildScoringContext(analysis, 'org');

    expect(existingByCategory.get('uncategorized')).toEqual(['Orphan statement']);
  });

  it('assigns uncategorized category when propertyId is null', () => {
    const analysis = makeGapAnalysis({
      allStatements: [
        { id: 1, variety: 'attributed', statementText: 'No property statement', subjectEntityId: 'org', propertyId: null, status: 'active' },
      ],
      propertyMap: new Map(),
    });

    const { existingByCategory } = buildScoringContext(analysis, 'org');

    expect(existingByCategory.get('uncategorized')).toEqual(['No property statement']);
  });

  it('converts statements to ScoringStatement format', () => {
    const analysis = makeGapAnalysis({
      allStatements: [
        { id: 42, variety: 'structured', statementText: 'Revenue was $1B.', subjectEntityId: 'org', propertyId: 'revenue', status: 'active' },
      ],
      propertyMap: new Map([['revenue', { category: 'financial' }]]),
    });

    const { existingScoringStmts } = buildScoringContext(analysis, 'org');

    expect(existingScoringStmts).toHaveLength(1);
    const stmt = existingScoringStmts[0];
    expect(stmt.id).toBe(42);
    expect(stmt.variety).toBe('structured');
    expect(stmt.statementText).toBe('Revenue was $1B.');
    expect(stmt.subjectEntityId).toBe('org');
    expect(stmt.propertyId).toBe('revenue');
    expect(stmt.status).toBe('active');
  });

  it('falls back to entityId for subjectEntityId when statement has null', () => {
    const analysis = makeGapAnalysis({
      allStatements: [
        { id: 1, variety: 'structured', statementText: 'Some statement.', subjectEntityId: null, propertyId: null, status: 'active' },
      ],
      propertyMap: new Map(),
    });

    const { existingScoringStmts } = buildScoringContext(analysis, 'fallback-entity');

    expect(existingScoringStmts[0].subjectEntityId).toBe('fallback-entity');
  });

  it('handles null statementText (preserves null in scoring stmt, uses empty string in category list)', () => {
    const analysis = makeGapAnalysis({
      allStatements: [
        { id: 1, variety: 'structured', statementText: null, subjectEntityId: 'org', propertyId: null, status: 'active' },
      ],
      propertyMap: new Map(),
    });

    const { existingScoringStmts, existingByCategory } = buildScoringContext(analysis, 'org');

    // The scoring statement preserves null for statementText (type cast: (null as string) ?? null = null)
    expect(existingScoringStmts[0].statementText).toBeNull();
    // The category list uses statementText ?? '' for grouping
    expect(existingByCategory.get('uncategorized')).toEqual(['']);
  });

  it('processes multiple categories correctly', () => {
    const analysis = makeGapAnalysis({
      allStatements: [
        { id: 1, variety: 'structured', statementText: 'Financial fact.', subjectEntityId: 'org', propertyId: 'revenue', status: 'active' },
        { id: 2, variety: 'attributed', statementText: 'Safety quote.', subjectEntityId: 'org', propertyId: 'safety-policy', status: 'active' },
        { id: 3, variety: 'structured', statementText: 'Another financial fact.', subjectEntityId: 'org', propertyId: 'funding', status: 'active' },
      ],
      propertyMap: new Map([
        ['revenue', { category: 'financial' }],
        ['safety-policy', { category: 'safety' }],
        ['funding', { category: 'financial' }],
      ]),
    });

    const { existingByCategory, existingScoringStmts } = buildScoringContext(analysis, 'org');

    expect(existingByCategory.get('financial')).toEqual(['Financial fact.', 'Another financial fact.']);
    expect(existingByCategory.get('safety')).toEqual(['Safety quote.']);
    expect(existingScoringStmts).toHaveLength(3);
  });
});
