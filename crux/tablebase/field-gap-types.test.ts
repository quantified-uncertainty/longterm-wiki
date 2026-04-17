import { describe, it, expect } from 'vitest';
import {
  fieldToTaskType,
  parseFieldGapReport,
  type FieldGapReport,
} from './field-gap-types.ts';

describe('fieldToTaskType', () => {
  it('maps divisions.lead_id to division-lead-fill', () => {
    expect(fieldToTaskType('divisions', 'lead_id')).toBe('division-lead-fill');
  });

  it('maps divisions.lead (legacy alias) to division-lead-fill', () => {
    expect(fieldToTaskType('divisions', 'lead')).toBe('division-lead-fill');
  });

  it('maps division-personnel.start_date to division-personnel-dates', () => {
    // Hyphenated table name should normalize to underscored form.
    expect(fieldToTaskType('division-personnel', 'start_date')).toBe('division-personnel-dates');
  });

  it('maps funding_programs fields to funding-program-enrichment', () => {
    expect(fieldToTaskType('funding_programs', 'total_budget')).toBe('funding-program-enrichment');
    expect(fieldToTaskType('funding_programs', 'deadline')).toBe('funding-program-enrichment');
    expect(fieldToTaskType('funding_programs', 'application_url')).toBe('funding-program-enrichment');
  });

  it('maps benchmark_results.source_url to benchmark-source-fill', () => {
    expect(fieldToTaskType('benchmark_results', 'source_url')).toBe('benchmark-source-fill');
  });

  it('normalizes camelCase fields to snake_case before lookup', () => {
    expect(fieldToTaskType('divisions', 'leadId')).toBe('division-lead-fill');
    expect(fieldToTaskType('funding_programs', 'applicationUrl')).toBe('funding-program-enrichment');
    expect(fieldToTaskType('benchmark_results', 'sourceUrl')).toBe('benchmark-source-fill');
  });

  it('returns null for unknown (table, field) pairs', () => {
    expect(fieldToTaskType('divisions', 'description')).toBeNull();
    expect(fieldToTaskType('unknown_table', 'any_field')).toBeNull();
  });

  it('is case-insensitive on table names', () => {
    expect(fieldToTaskType('Divisions', 'lead_id')).toBe('division-lead-fill');
  });
});

describe('parseFieldGapReport', () => {
  it('parses a full FieldGapReport with timestamp + gaps', () => {
    const json = JSON.stringify({
      timestamp: '2026-04-16T12:00:00Z',
      gaps: [
        { table: 'divisions', field: 'lead_id', nullCount: 194, nullPercent: 97, totalRows: 200 },
      ],
    });

    const report = parseFieldGapReport(json);
    expect(report.timestamp).toBe('2026-04-16T12:00:00Z');
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0]).toMatchObject({
      table: 'divisions',
      field: 'lead_id',
      nullCount: 194,
      nullPercent: 97,
      totalRows: 200,
    });
  });

  it('accepts a bare array of gaps (no wrapper)', () => {
    const json = JSON.stringify([
      { table: 'divisions', field: 'lead_id', nullCount: 10, nullPercent: 50, totalRows: 20 },
    ]);

    const report = parseFieldGapReport(json);
    expect(report.gaps).toHaveLength(1);
    expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('preserves targetRowIds when provided', () => {
    const json = JSON.stringify({
      gaps: [
        {
          table: 'divisions',
          field: 'lead_id',
          nullCount: 2,
          nullPercent: 10,
          totalRows: 20,
          targetRowIds: ['div_abc', 'div_def'],
        },
      ],
    });

    const report = parseFieldGapReport(json);
    expect(report.gaps[0].targetRowIds).toEqual(['div_abc', 'div_def']);
  });

  it('filters non-string entries from targetRowIds (adversarial input)', () => {
    const json = JSON.stringify({
      gaps: [
        {
          table: 'divisions',
          field: 'lead_id',
          nullCount: 2,
          nullPercent: 10,
          totalRows: 20,
          targetRowIds: ['div_abc', 123, null, 'div_def'],
        },
      ],
    });

    const report = parseFieldGapReport(json);
    expect(report.gaps[0].targetRowIds).toEqual(['div_abc', 'div_def']);
  });

  it('defaults missing numeric fields to 0 rather than crashing', () => {
    const json = JSON.stringify({
      gaps: [{ table: 'divisions', field: 'lead_id' }],
    });

    const report = parseFieldGapReport(json);
    expect(report.gaps[0]).toMatchObject({
      table: 'divisions',
      field: 'lead_id',
      nullCount: 0,
      nullPercent: 0,
      totalRows: 0,
    });
  });

  it('ignores unknown extra fields (forward-compat with QUA-551 scanner output)', () => {
    const json = JSON.stringify({
      gaps: [
        {
          table: 'divisions',
          field: 'lead_id',
          nullCount: 10,
          nullPercent: 50,
          totalRows: 20,
          severity: 'high',
          suggestedTaskType: 'division-lead-fill',
        },
      ],
    });

    const report: FieldGapReport = parseFieldGapReport(json);
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0].table).toBe('divisions');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseFieldGapReport('{not valid')).toThrow(/Invalid JSON/);
  });

  it('throws when top-level is neither array nor { gaps: [] }', () => {
    expect(() => parseFieldGapReport(JSON.stringify({ foo: 'bar' }))).toThrow(/must be an array/);
  });

  it('throws when a gap is missing required table/field', () => {
    const json = JSON.stringify({ gaps: [{ nullCount: 10 }] });
    expect(() => parseFieldGapReport(json)).toThrow(/missing required/);
  });

  it('throws on non-object gap entries', () => {
    const json = JSON.stringify({ gaps: ['not-an-object'] });
    expect(() => parseFieldGapReport(json)).toThrow(/not an object/);
  });
});
