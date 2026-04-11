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
  sourcing: {
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

describe('matchRecordAgainstSnapshot — null-field handling', () => {
  it('returns unverifiable when fewer than 2 non-null fields exist', () => {
    const result = matchRecordAgainstSnapshot(
      { grantee: 'MIRI', amount: null, date: null },
      CSV_CONTENT,
      testManifest,
    );
    expect(result.matched).toBe(false);
    expect(result.confidence).toBe(0.1);
    expect(result.reasoning).toContain('Insufficient data');
    expect(result.reasoning).toContain('1 of 3');
  });

  it('returns unverifiable when all fields are null', () => {
    const result = matchRecordAgainstSnapshot(
      { grantee: null, amount: null, date: null },
      CSV_CONTENT,
      testManifest,
    );
    expect(result.matched).toBe(false);
    expect(result.confidence).toBe(0.1);
    expect(result.reasoning).toContain('Insufficient data');
    expect(result.reasoning).toContain('0 of 3');
  });

  it('uses total match fields as denominator, not just non-null fields', () => {
    // With 3 match fields (grantee, amount, date), only providing 2 means
    // the maximum possible score is 2/3 (~0.67), not 2/2 (1.0)
    const result = matchRecordAgainstSnapshot(
      { grantee: 'MIRI', amount: 500000, date: null },
      CSV_CONTENT,
      testManifest,
    );
    // 2 fields match out of 3 total → score ~0.67, which is a partial match
    expect(result.matched).toBe(true);
    expect(result.confidence).toBeLessThanOrEqual(0.8); // capped at 0.8 for partial
    expect(result.fieldsMatched).toContain('grantee');
    expect(result.fieldsMatched).toContain('amount');
  });
});

describe('matchRecordAgainstSnapshot — duplicate grantee+amount disambiguation', () => {
  // Regression test for EA Funds bug: multiple grants with identical grantee+amount
  // in the same month would collide when matchFields only contained ['grantee', 'amount'].
  // Adding 'name' (and 'date') to matchFields resolves the collision.
  const eaFundsStyleManifest: DataSourceManifest = {
    ...testManifest,
    sourceId: 'ea-funds',
    sourcing: {
      strategy: 'deterministic_row_match',
      matchFields: ['grantee', 'amount', 'date', 'name'],
      fuzzyFields: ['grantee', 'name'],
      exactFields: ['amount'],
    },
  };

  const DUPLICATE_CSV = `Organization,Amount,Date,Grant Name
"Effective Giving Quest","$40,000","2023-03","Creation of a new organisation that increases the philanthropic impact of the gaming space via promotion of EA and EAA charities"
"Effective Giving Quest","$40,000","2023-03","Top-up funding to enable us to gauge viability of strategy before deciding to pursue additional exte..."
"Other Org","$100,000","2023-01","Some other grant"
`;

  it('matches the correct row when grantee+amount are duplicated but name differs', () => {
    const result = matchRecordAgainstSnapshot(
      {
        grantee: 'Effective Giving Quest',
        amount: 40000,
        date: '2023-03',
        name: 'Creation of a new organisation that increases the philanthropic impact of the gaming space via promotion of EA and EAA charities',
      },
      DUPLICATE_CSV,
      eaFundsStyleManifest,
    );
    expect(result.matched).toBe(true);
    expect(result.fieldsMatched).toContain('name');
    // The matched row should have the correct grant name, not the top-up grant
    expect(JSON.stringify(result.matchedRow)).toContain('Creation of a new organisation');
    expect(JSON.stringify(result.matchedRow)).not.toContain('Top-up funding');
  });

  it('does NOT match a row with a different grant name even when grantee+amount match', () => {
    // With only grantee+amount, both rows would score equally and a wrong row could be chosen.
    // With name in matchFields, the wrong name causes a mismatch field and lowers the score.
    const result = matchRecordAgainstSnapshot(
      {
        grantee: 'Effective Giving Quest',
        amount: 40000,
        date: '2023-03',
        name: 'Top-up funding to enable us to gauge viability of strategy before deciding to pursue additional exte...',
      },
      DUPLICATE_CSV,
      eaFundsStyleManifest,
    );
    expect(result.matched).toBe(true);
    // The matched row should be the top-up grant, not the gaming space grant
    expect(JSON.stringify(result.matchedRow)).toContain('Top-up funding');
    expect(JSON.stringify(result.matchedRow)).not.toContain('Creation of a new organisation');
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
    sourcing: {
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
