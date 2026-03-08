/**
 * Tests for statement audit detection logic.
 */

import { describe, it, expect } from 'vitest';
import { detectActiveConflicts } from './audit.ts';
import type { StatementRow } from '../lib/wiki-server/statements.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let nextId = 1;

function makeStatement(overrides: Partial<StatementRow> = {}): StatementRow {
  return {
    id: nextId++,
    variety: 'structured',
    statementText: 'Test statement.',
    status: 'active',
    subjectEntityId: 'anthropic',
    propertyId: 'revenue',
    qualifierKey: null,
    qualifierValue: null,
    valueNumeric: null,
    valueUnit: null,
    valueText: null,
    valueEntityId: null,
    valueDate: '2026-02',
    valueSeries: null,
    validStart: null,
    validEnd: null,
    temporalGranularity: null,
    attributedTo: null,
    claimCategory: 'factual',
    verdict: null,
    verdictScore: null,
    verdictModel: null,
    note: null,
    sourceFactKey: null,
    archiveReason: null,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...overrides,
  } as StatementRow;
}

// ---------------------------------------------------------------------------
// DUPLICATE_ACTIVE
// ---------------------------------------------------------------------------

describe('detectActiveConflicts — DUPLICATE_ACTIVE', () => {
  it('flags two active statements with same property, numeric value, and date', () => {
    const stmts = [
      makeStatement({ id: 100, propertyId: 'revenue-guidance', valueNumeric: 70e9, valueDate: '2028' }),
      makeStatement({ id: 101, propertyId: 'revenue-guidance', valueNumeric: 70e9, valueDate: '2028' }),
    ];
    const issues = detectActiveConflicts(stmts);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('DUPLICATE_ACTIVE');
    expect((issues[0] as { ids: number[] }).ids).toEqual([100, 101]);
  });

  it('flags two active statements with same property, text value, and date', () => {
    const stmts = [
      makeStatement({ id: 200, propertyId: 'headquarters', valueText: 'San Francisco', valueDate: null }),
      makeStatement({ id: 201, propertyId: 'headquarters', valueText: 'San Francisco', valueDate: null }),
    ];
    const issues = detectActiveConflicts(stmts);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('DUPLICATE_ACTIVE');
    expect((issues[0] as { ids: number[] }).ids).toEqual([200, 201]);
  });

  it('puts the older (lower) id first', () => {
    const stmts = [
      makeStatement({ id: 999, propertyId: 'revenue-guidance', valueNumeric: 70e9, valueDate: '2028' }),
      makeStatement({ id: 111, propertyId: 'revenue-guidance', valueNumeric: 70e9, valueDate: '2028' }),
    ];
    const issues = detectActiveConflicts(stmts);
    expect(issues[0]!.ids[0]).toBe(111);
    expect(issues[0]!.ids[1]).toBe(999);
  });

  it('does not flag statements with the same property but different dates', () => {
    const stmts = [
      makeStatement({ propertyId: 'revenue', valueNumeric: 7e9, valueDate: '2025-10' }),
      makeStatement({ propertyId: 'revenue', valueNumeric: 7e9, valueDate: '2025-11' }),
    ];
    expect(detectActiveConflicts(stmts)).toHaveLength(0);
  });

  it('does not flag retracted statements', () => {
    const stmts = [
      makeStatement({ id: 300, propertyId: 'revenue', valueNumeric: 19e9, valueDate: '2026-03' }),
      makeStatement({ id: 301, propertyId: 'revenue', valueNumeric: 19e9, valueDate: '2026-03', status: 'retracted' }),
    ];
    expect(detectActiveConflicts(stmts)).toHaveLength(0);
  });

  it('does not flag statements with no propertyId', () => {
    const stmts = [
      makeStatement({ propertyId: null, valueNumeric: 19e9, valueDate: '2026-03' }),
      makeStatement({ propertyId: null, valueNumeric: 19e9, valueDate: '2026-03' }),
    ];
    expect(detectActiveConflicts(stmts)).toHaveLength(0);
  });

  it('does not flag when either statement has a qualifierKey', () => {
    const stmts = [
      makeStatement({ id: 400, propertyId: 'equity-stake-percent', valueNumeric: 14, valueDate: '2023-10', qualifierKey: 'investor' }),
      makeStatement({ id: 401, propertyId: 'equity-stake-percent', valueNumeric: 14, valueDate: '2023-10', qualifierKey: 'investor' }),
    ];
    // Both have qualifier — not flagged
    expect(detectActiveConflicts(stmts)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// NEEDS_QUALIFIER
// ---------------------------------------------------------------------------

describe('detectActiveConflicts — NEEDS_QUALIFIER', () => {
  it('flags two active statements with same property and date but different values', () => {
    const stmts = [
      makeStatement({ id: 500, propertyId: 'equity-stake-percent', valueNumeric: 2.5, valueDate: '2026-02' }),
      makeStatement({ id: 501, propertyId: 'equity-stake-percent', valueNumeric: 15, valueDate: '2026-02' }),
    ];
    const issues = detectActiveConflicts(stmts);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('NEEDS_QUALIFIER');
    expect((issues[0] as { values: string[] }).values).toEqual(['2.5', '15']);
  });

  it('does not flag when either already has a qualifierKey set', () => {
    const stmts = [
      makeStatement({ id: 600, propertyId: 'equity-stake-percent', valueNumeric: 2.5, valueDate: '2026-02', qualifierKey: 'subject' }),
      makeStatement({ id: 601, propertyId: 'equity-stake-percent', valueNumeric: 15, valueDate: '2026-02' }),
    ];
    expect(detectActiveConflicts(stmts)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Mixed scenarios
// ---------------------------------------------------------------------------

describe('detectActiveConflicts — mixed', () => {
  it('detects multiple issues in the same entity', () => {
    const stmts = [
      // Duplicate pair
      makeStatement({ id: 700, propertyId: 'revenue-guidance', valueNumeric: 70e9, valueDate: '2028' }),
      makeStatement({ id: 701, propertyId: 'revenue-guidance', valueNumeric: 70e9, valueDate: '2028' }),
      // Needs-qualifier pair
      makeStatement({ id: 702, propertyId: 'equity-stake-percent', valueNumeric: 2.5, valueDate: '2026-02' }),
      makeStatement({ id: 703, propertyId: 'equity-stake-percent', valueNumeric: 15, valueDate: '2026-02' }),
      // Clean — different dates
      makeStatement({ id: 704, propertyId: 'revenue', valueNumeric: 7e9, valueDate: '2025-10' }),
      makeStatement({ id: 705, propertyId: 'revenue', valueNumeric: 14e9, valueDate: '2026-02' }),
    ];
    const issues = detectActiveConflicts(stmts);
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.type).sort()).toEqual(['DUPLICATE_ACTIVE', 'NEEDS_QUALIFIER']);
  });

  it('returns empty array for a clean statement set', () => {
    const stmts = [
      makeStatement({ propertyId: 'revenue', valueNumeric: 19e9, valueDate: '2026-03' }),
      makeStatement({ propertyId: 'valuation', valueNumeric: 380e9, valueDate: '2026-02' }),
      makeStatement({ propertyId: 'headcount', valueNumeric: 4074, valueDate: '2026-01' }),
    ];
    expect(detectActiveConflicts(stmts)).toHaveLength(0);
  });
});
