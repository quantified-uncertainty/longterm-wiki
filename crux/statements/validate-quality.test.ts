/**
 * Tests for data quality assertions in the statements extraction pipeline.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  validateExtractedStatements,
  validateCreateStatementBatch,
  printQualityReport,
} from './validate-quality.ts';
import type { ExtractedStatement } from './extract.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStatement(overrides: Partial<ExtractedStatement> = {}): ExtractedStatement {
  return {
    statementText: 'Anthropic was founded in 2021 by Dario Amodei and colleagues.',
    variety: 'structured',
    propertyId: 'founded',
    valueNumeric: null,
    valueUnit: null,
    valueText: '2021',
    valueEntityId: null,
    valueDate: '2021',
    validStart: '2021',
    temporalGranularity: 'year',
    attributedTo: null,
    claimCategory: 'factual',
    qualifierKey: null,
    footnoteRefs: [],
    section: 'Overview',
    inferenceType: 'direct_assertion',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateExtractedStatements
// ---------------------------------------------------------------------------

describe('validateExtractedStatements', () => {
  it('passes for a clean batch of statements', () => {
    const statements = [
      makeStatement({ statementText: 'Anthropic raised $7.3B in a Series E round in 2024.' }),
      makeStatement({ statementText: 'Anthropic was founded in 2021 by Dario Amodei.', valueNumeric: 2021 }),
      makeStatement({ statementText: 'Anthropic employs over 1000 researchers.', valueNumeric: 1000 }),
    ];
    const report = validateExtractedStatements(statements, 5);
    expect(report.passed).toBe(true);
    expect(report.violations).toHaveLength(0);
    expect(report.stats.emptyText).toBe(0);
    expect(report.stats.nanValues).toBe(0);
    expect(report.stats.allZeroNumeric).toBe(false);
    expect(report.stats.zeroStatements).toBe(false);
  });

  it('detects zero statements from a multi-section page', () => {
    const report = validateExtractedStatements([], 3);
    expect(report.passed).toBe(false);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].code).toBe('ZERO_STATEMENTS');
    expect(report.stats.zeroStatements).toBe(true);
  });

  it('does NOT flag zero statements for a very short page (fewer than 2 sections)', () => {
    const report = validateExtractedStatements([], 1);
    expect(report.passed).toBe(true);
  });

  it('does NOT flag zero statements when sectionCount is 0', () => {
    const report = validateExtractedStatements([], 0);
    expect(report.passed).toBe(true);
  });

  it('detects empty statement text', () => {
    const statements = [
      makeStatement({ statementText: '' }),
      makeStatement({ statementText: '   ' }),
      makeStatement({ statementText: 'Anthropic employs over 1000 researchers.' }),
    ];
    const report = validateExtractedStatements(statements, 5);
    expect(report.passed).toBe(false);
    const emptyCodes = report.violations.map(v => v.code);
    expect(emptyCodes.filter(c => c === 'EMPTY_STATEMENT_TEXT')).toHaveLength(2);
    expect(report.stats.emptyText).toBe(2);
  });

  it('detects NaN numeric values', () => {
    const statements = [
      makeStatement({ statementText: 'Anthropic raised money.', valueNumeric: NaN }),
      makeStatement({ statementText: 'Anthropic raised a lot.', valueNumeric: Infinity }),
      makeStatement({ statementText: 'Anthropic has offices.', valueNumeric: null }),
    ];
    const report = validateExtractedStatements(statements, 4);
    expect(report.passed).toBe(false);
    const nanCodes = report.violations.map(v => v.code);
    expect(nanCodes.filter(c => c === 'NON_FINITE_NUMERIC')).toHaveLength(2);
    expect(report.stats.nanValues).toBe(2);
  });

  it('detects all-zero numeric values (batch extraction failure)', () => {
    const statements = [
      makeStatement({ statementText: 'First fact about Anthropic.', valueNumeric: 0 }),
      makeStatement({ statementText: 'Second fact about Anthropic.', valueNumeric: 0 }),
      makeStatement({ statementText: 'Third fact about Anthropic.', valueNumeric: 0 }),
    ];
    const report = validateExtractedStatements(statements, 5);
    expect(report.passed).toBe(false);
    expect(report.violations.some(v => v.code === 'ALL_ZERO_NUMERIC')).toBe(true);
    expect(report.stats.allZeroNumeric).toBe(true);
  });

  it('does NOT flag all-zero when fewer than 3 numeric values', () => {
    const statements = [
      makeStatement({ statementText: 'Anthropic raised money.', valueNumeric: 0 }),
      makeStatement({ statementText: 'Anthropic has offices.', valueNumeric: null }),
    ];
    const report = validateExtractedStatements(statements, 4);
    // Only 1 numeric value — threshold not reached
    expect(report.stats.allZeroNumeric).toBe(false);
  });

  it('does NOT flag all-zero when values include non-zero entries', () => {
    const statements = [
      makeStatement({ statementText: 'Founded in year.', valueNumeric: 0 }),
      makeStatement({ statementText: 'Employees.', valueNumeric: 1500 }),
      makeStatement({ statementText: 'Funding.', valueNumeric: 0 }),
    ];
    const report = validateExtractedStatements(statements, 4);
    expect(report.stats.allZeroNumeric).toBe(false);
  });

  it('returns multiple violation types in a single report', () => {
    const statements = [
      makeStatement({ statementText: '' }),          // empty text
      makeStatement({ statementText: 'Valid fact about Anthropic.', valueNumeric: NaN }), // NaN
    ];
    const report = validateExtractedStatements(statements, 5);
    expect(report.passed).toBe(false);
    expect(report.violationCount).toBeGreaterThanOrEqual(2);
  });

  it('includes excerpt of statement text in violation details', () => {
    const statements = [makeStatement({ statementText: 'X fact.', valueNumeric: NaN })];
    const report = validateExtractedStatements(statements, 3);
    const nanViolation = report.violations.find(v => v.code === 'NON_FINITE_NUMERIC');
    expect(nanViolation?.excerpt).toBeDefined();
    expect(nanViolation?.excerpt).toContain('X fact.');
  });
});

// ---------------------------------------------------------------------------
// validateCreateStatementBatch
// ---------------------------------------------------------------------------

describe('validateCreateStatementBatch', () => {
  it('passes for a valid batch', () => {
    const items = [
      { variety: 'structured' as const, statementText: 'Anthropic raised $7.3B.', subjectEntityId: 'anthropic', valueNumeric: 7300000000 },
      { variety: 'structured' as const, statementText: 'Anthropic was founded in 2021.', subjectEntityId: 'anthropic', valueNumeric: null },
    ];
    const report = validateCreateStatementBatch(items);
    expect(report.passed).toBe(true);
    expect(report.violations).toHaveLength(0);
  });

  it('detects empty statementText', () => {
    const items = [
      { variety: 'structured' as const, statementText: '', subjectEntityId: 'anthropic', valueNumeric: null },
    ];
    const report = validateCreateStatementBatch(items);
    expect(report.passed).toBe(false);
    expect(report.violations[0].code).toBe('EMPTY_STATEMENT_TEXT');
  });

  it('detects NaN valueNumeric', () => {
    const items = [
      { variety: 'structured' as const, statementText: 'Anthropic revenue.', subjectEntityId: 'anthropic', valueNumeric: NaN },
    ];
    const report = validateCreateStatementBatch(items);
    expect(report.passed).toBe(false);
    expect(report.violations[0].code).toBe('NON_FINITE_NUMERIC');
  });

  it('detects all-zero numeric values in batch', () => {
    const items = [
      { variety: 'structured' as const, statementText: 'Fact 1.', subjectEntityId: 'anthropic', valueNumeric: 0 },
      { variety: 'structured' as const, statementText: 'Fact 2.', subjectEntityId: 'anthropic', valueNumeric: 0 },
      { variety: 'structured' as const, statementText: 'Fact 3.', subjectEntityId: 'anthropic', valueNumeric: 0 },
    ];
    const report = validateCreateStatementBatch(items);
    expect(report.passed).toBe(false);
    expect(report.violations.some(v => v.code === 'ALL_ZERO_NUMERIC')).toBe(true);
  });

  it('passes for an empty batch (zero items is not an error for improve pipeline)', () => {
    const report = validateCreateStatementBatch([]);
    expect(report.passed).toBe(true);
    expect(report.stats.zeroStatements).toBe(true);
    // improve pipeline may have 0 accepted statements if quality gate rejects all
  });

  it('detects duplicate (subjectEntityId, propertyId, valueDate) tuples', () => {
    const items = [
      { variety: 'structured' as const, statementText: 'Anthropic founded in 2021.', subjectEntityId: 'anthropic', propertyId: 'founded', valueDate: '2021', valueNumeric: null },
      { variety: 'structured' as const, statementText: 'Anthropic founded 2021 (duplicate).', subjectEntityId: 'anthropic', propertyId: 'founded', valueDate: '2021', valueNumeric: null },
    ];
    const report = validateCreateStatementBatch(items);
    expect(report.passed).toBe(false);
    expect(report.violations.some(v => v.code === 'DUPLICATE_TUPLE')).toBe(true);
    expect(report.violations.find(v => v.code === 'DUPLICATE_TUPLE')?.statementIndex).toBe(1);
  });

  it('does not flag distinct tuples as duplicates', () => {
    const items = [
      { variety: 'structured' as const, statementText: 'Anthropic founded in 2021.', subjectEntityId: 'anthropic', propertyId: 'founded', valueDate: '2021', valueNumeric: null },
      { variety: 'structured' as const, statementText: 'Anthropic employees in 2023.', subjectEntityId: 'anthropic', propertyId: 'employees', valueDate: '2023', valueNumeric: null },
    ];
    const report = validateCreateStatementBatch(items);
    expect(report.violations.some(v => v.code === 'DUPLICATE_TUPLE')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// printQualityReport
// ---------------------------------------------------------------------------

const mockColors = {
  red: '',
  yellow: '',
  green: '',
  bold: '',
  dim: '',
  reset: '',
};

describe('printQualityReport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs green pass message when report passed', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const report = validateCreateStatementBatch([
      { variety: 'structured' as const, statementText: 'Valid statement.', subjectEntityId: 'anthropic', valueNumeric: null },
    ]);
    printQualityReport(report, mockColors, false);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('all assertions passed'));
  });

  it('logs WARNING in dry-run mode when violations exist', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const report = validateCreateStatementBatch([
      { variety: 'structured' as const, statementText: '', subjectEntityId: 'anthropic', valueNumeric: null },
    ]);
    printQualityReport(report, mockColors, true);
    const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('WARNING');
    expect(output).toContain('dry-run');
  });

  it('logs ERROR and abort message in apply mode when violations exist', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const report = validateCreateStatementBatch([
      { variety: 'structured' as const, statementText: '', subjectEntityId: 'anthropic', valueNumeric: null },
    ]);
    printQualityReport(report, mockColors, false);
    const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('ERROR');
    expect(output).toContain('Pipeline aborted');
  });
});
