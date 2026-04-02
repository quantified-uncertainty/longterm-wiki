import { describe, it, expect } from 'vitest';
import { matchRecordAgainstSnapshot } from './deterministic-matcher.ts';
import type { DataSourceManifest } from '../grant-import/manifests/types.ts';

const testManifest: DataSourceManifest = {
  sourceId: 'test-source',
  name: 'Test Source',
  fetchUrl: 'https://example.com/grants.csv',
  format: 'csv',
  accessMethod: 'direct_download',
  updateFrequency: 'quarterly',
  cachePath: '/tmp/test.csv',
  schema: {
    fields: [
      { sourceName: 'Organization', internalField: 'grantee', type: 'string' },
      { sourceName: 'Amount', internalField: 'amount', type: 'currency' },
      { sourceName: 'Date', internalField: 'date', type: 'date' },
      { sourceName: 'Grant Name', internalField: 'name', type: 'string' },
    ],
  },
  verification: {
    strategy: 'deterministic_row_match',
    matchFields: ['grantee', 'amount', 'date'],
    fuzzyFields: ['grantee'],
    exactFields: ['amount'],
  },
};

const CSV_CONTENT = `Organization,Amount,Date,Grant Name
"MIRI","$500,000","2018-07","General Support"
"Anthropic Inc.","$10,000,000","2023-01","AI Safety Research"
"Center for AI Safety","$2,500,000","2022-06","Operations"
"80,000 Hours","$1,200,000","2021-03","Career Guidance"
`;

describe('matchRecordAgainstSnapshot', () => {
  it('matches an exact grant', () => {
    const result = matchRecordAgainstSnapshot(
      { grantee: 'MIRI', amount: 500000, date: '2018-07' },
      CSV_CONTENT,
      testManifest,
    );
    expect(result.matched).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.8);
    expect(result.fieldsMatched).toContain('grantee');
    expect(result.fieldsMatched).toContain('amount');
  });

  it('matches with fuzzy name (suffix stripping)', () => {
    const result = matchRecordAgainstSnapshot(
      { grantee: 'Anthropic', amount: 10000000, date: '2023-01' },
      CSV_CONTENT,
      testManifest,
    );
    expect(result.matched).toBe(true);
    expect(result.fieldsMatched).toContain('grantee');
  });

  it('returns unverifiable when not found', () => {
    const result = matchRecordAgainstSnapshot(
      { grantee: 'DeepMind', amount: 999999, date: '2020-01' },
      CSV_CONTENT,
      testManifest,
    );
    expect(result.matched).toBe(false);
    expect(result.confidence).toBeLessThan(0.5);
  });

  it('matches with date granularity tolerance', () => {
    const result = matchRecordAgainstSnapshot(
      { grantee: 'MIRI', amount: 500000, date: '2018' },
      CSV_CONTENT,
      testManifest,
    );
    expect(result.matched).toBe(true);
  });

  it('handles empty CSV', () => {
    const result = matchRecordAgainstSnapshot(
      { grantee: 'MIRI', amount: 500000 },
      '',
      testManifest,
    );
    expect(result.matched).toBe(false);
    expect(result.reasoning).toContain('Could not parse');
  });

  it('handles CSV with commas in amounts', () => {
    // "80,000 Hours" has a comma in the org name, and "$1,200,000" has commas
    const result = matchRecordAgainstSnapshot(
      { grantee: '80,000 Hours', amount: 1200000, date: '2021-03' },
      CSV_CONTENT,
      testManifest,
    );
    expect(result.matched).toBe(true);
  });

  it('returns partial match when some fields differ', () => {
    const result = matchRecordAgainstSnapshot(
      { grantee: 'MIRI', amount: 600000, date: '2018-07' },
      CSV_CONTENT,
      testManifest,
    );
    // Name matches but amount doesn't — should be partial
    expect(result.fieldsMatched).toContain('grantee');
    expect(result.fieldsMatched).toContain('date');
    expect(result.fieldsMismatched).toContain('amount');
  });
});

describe('matchRecordAgainstSnapshot with JSON', () => {
  const jsonManifest: DataSourceManifest = {
    ...testManifest,
    format: 'json_api',
    schema: {
      fields: [
        { sourceName: 'title', internalField: 'name', type: 'string' },
        { sourceName: 'funding_goal', internalField: 'amount', type: 'number' },
      ],
    },
    verification: {
      strategy: 'deterministic_row_match',
      matchFields: ['name', 'amount'],
      fuzzyFields: ['name'],
    },
  };

  const JSON_CONTENT = JSON.stringify([
    { title: 'AI Safety Project', funding_goal: 50000, slug: 'ai-safety' },
    { title: 'Alignment Research', funding_goal: 100000, slug: 'alignment' },
  ]);

  it('matches JSON API content', () => {
    const result = matchRecordAgainstSnapshot(
      { name: 'AI Safety Project', amount: 50000 },
      JSON_CONTENT,
      jsonManifest,
    );
    expect(result.matched).toBe(true);
    expect(result.fieldsMatched).toContain('name');
    expect(result.fieldsMatched).toContain('amount');
  });
});
