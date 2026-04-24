import { describe, expect, it } from 'vitest';
import { extractFinancialFacts } from './factbase-import-990.ts';

function makeFiling(over: Partial<{
  tax_prd: number;
  tax_prd_yr: number;
  formtype: number;
  totrevenue: number;
  totfuncexpns: number;
  totassetsend: number;
  totliabend: number;
  totnetassetend: number;
  ein: number;
}> = {}) {
  return {
    tax_prd: 201712,
    tax_prd_yr: 2017,
    formtype: 0,
    totrevenue: 1000,
    totfuncexpns: 800,
    totassetsend: 5000,
    totliabend: 0,
    totnetassetend: 5000,
    ein: 123456789,
    ...over,
  };
}

function makeOrg(filings: ReturnType<typeof makeFiling>[]) {
  return {
    organization: {
      ein: 123456789,
      name: 'Test Org',
      city: 'Test',
      state: 'CA',
      sort_name: 'Test',
    },
    filings_with_data: filings,
    filings_without_data: [],
  } as never;
}

describe('extractFinancialFacts', () => {
  it('emits revenue / annual-expenses / net-assets for a single filing', () => {
    const facts = extractFinancialFacts('e1', makeOrg([makeFiling()]));
    expect(facts.map((f) => f.property).sort()).toEqual([
      'annual-expenses',
      'net-assets',
      'revenue',
    ]);
  });

  it('CodeRabbit review on PR #4538: deduplicates filings with identical (tax_prd_yr, tax_prd)', () => {
    // Two filings for the same period — without dedup, both produce
    // facts with the same (property, asOf) key. Both would be written,
    // polluting the time series. Keep first occurrence.
    const facts = extractFinancialFacts(
      'e1',
      makeOrg([
        makeFiling({ tax_prd_yr: 2017, tax_prd: 201712, totrevenue: 100 }),
        makeFiling({ tax_prd_yr: 2017, tax_prd: 201712, totrevenue: 999 }),
      ]),
    );
    const revenueFacts = facts.filter((f) => f.property === 'revenue');
    expect(revenueFacts).toHaveLength(1);
    expect(revenueFacts[0].value).toBe(100);
    expect(revenueFacts[0].asOf).toBe('2017');
  });

  it('keeps both filings when same year but different periods (legitimate dual filings)', () => {
    // Two filings for same year but different periods (e.g. fiscal-year
    // transition: short period + full year). Disambiguated via YYYY-MM asOf.
    const facts = extractFinancialFacts(
      'e1',
      makeOrg([
        makeFiling({ tax_prd_yr: 2017, tax_prd: 201706, totrevenue: 100 }),
        makeFiling({ tax_prd_yr: 2017, tax_prd: 201712, totrevenue: 200 }),
      ]),
    );
    const revenueFacts = facts.filter((f) => f.property === 'revenue');
    expect(revenueFacts).toHaveLength(2);
    expect(revenueFacts.map((f) => f.asOf).sort()).toEqual(['2017-06', '2017-12']);
  });

  it('skips totrevenue=0 but keeps annual-expenses=0 and net-assets=0', () => {
    const facts = extractFinancialFacts(
      'e1',
      makeOrg([makeFiling({ totrevenue: 0, totfuncexpns: 0, totnetassetend: 0 })]),
    );
    // CodeRabbit review on PR #4538: annual-expenses=0 is meaningful (e.g.
    // newly-formed foundations that haven't started spending yet), so emit
    // it with an explanatory note rather than skipping. totrevenue=0 still
    // skipped (an org with no revenue isn't worth tracking).
    expect(facts.map((f) => f.property).sort()).toEqual([
      'annual-expenses',
      'net-assets',
    ]);
    const expensesFact = facts.find((f) => f.property === 'annual-expenses');
    expect(expensesFact?.value).toBe(0);
    expect(expensesFact?.notes).toMatch(/no operational spending/);
  });
});
