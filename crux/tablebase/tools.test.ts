import { describe, it, expect } from 'vitest';
import { ensureSidPrefix, __testing__ } from './tools.ts';

describe('ensureSidPrefix', () => {
  it('adds sid_ prefix to a bare 10-char stableId', () => {
    expect(ensureSidPrefix('cMKB5i2WZQ')).toBe('sid_cMKB5i2WZQ');
  });

  it('leaves an already-prefixed stableId unchanged (no double prefix)', () => {
    // Regression: stored stableIds in database.json are already sid_-prefixed.
    // Naive `SID_PREFIX + stableId` produced sid_sid_XXX which the server
    // rejected, causing every benchmark-result-fill task to fail.
    expect(ensureSidPrefix('sid_cMKB5i2WZQ')).toBe('sid_cMKB5i2WZQ');
  });

  it('is idempotent when applied repeatedly', () => {
    const once = ensureSidPrefix('cMKB5i2WZQ');
    const twice = ensureSidPrefix(once);
    const thrice = ensureSidPrefix(twice);
    expect(once).toBe('sid_cMKB5i2WZQ');
    expect(twice).toBe('sid_cMKB5i2WZQ');
    expect(thrice).toBe('sid_cMKB5i2WZQ');
  });

  it('never produces sid_sid_ for well-formed inputs', () => {
    // stripSid only strips one prefix, so pathological sid_sid_XXX inputs
    // are not round-trip-cleaned. The contract is: any bare or single-prefixed
    // stableId yields a single-prefixed result.
    const inputs = ['bare10chars', 'sid_bare10char', 'xyz', ''];
    for (const input of inputs) {
      expect(ensureSidPrefix(input)).not.toMatch(/^sid_sid_/);
    }
  });
});

describe('resolveNonEntityForeignKeys', () => {
  const { resolveNonEntityForeignKeys, NON_ENTITY_REFS_BY_TABLE } = __testing__;

  const slugMap = new Map<string, string>([
    ['sid_pDqehtEoiw', 'mmlu'],
    ['pDqehtEoiw', 'mmlu'],
    ['sid_7nyWJfSgOQ', 'humaneval'],
  ]);

  it('registers benchmarkId as a non-entity FK for benchmark-results', () => {
    expect(NON_ENTITY_REFS_BY_TABLE['benchmark-results']).toEqual(['benchmarkId']);
  });

  it('translates sid_ benchmarkId to slug for benchmark-results', () => {
    // Regression: resolve_entity returns `sid_pDqehtEoiw` for MMLU, but
    // /api/benchmark-results/sync checks benchmarks.id / benchmarks.slug and
    // rejects entity stableIds. Converting to slug lets the server's
    // `slug IN (...)` branch match.
    const records = [
      { benchmarkId: 'sid_pDqehtEoiw', modelId: 'sid_cMKB5i2WZQ', score: 82 },
      { benchmarkId: 'sid_7nyWJfSgOQ', modelId: 'sid_cMKB5i2WZQ', score: 73 },
    ];
    resolveNonEntityForeignKeys('benchmark-results', records, slugMap);
    expect(records[0].benchmarkId).toBe('mmlu');
    expect(records[1].benchmarkId).toBe('humaneval');
  });

  it('leaves slug-form benchmarkId unchanged (no double-translation)', () => {
    const records = [{ benchmarkId: 'mmlu', modelId: 'sid_x', score: 82 }];
    resolveNonEntityForeignKeys('benchmark-results', records, slugMap);
    expect(records[0].benchmarkId).toBe('mmlu');
  });

  it('leaves benchmarkId unchanged when stableId is unknown', () => {
    // Unknown IDs fall through so the server's validation still flags them.
    const records = [{ benchmarkId: 'sid_fabricated', modelId: 'sid_x', score: 82 }];
    resolveNonEntityForeignKeys('benchmark-results', records, slugMap);
    expect(records[0].benchmarkId).toBe('sid_fabricated');
  });

  it('is a no-op for tables with no non-entity FKs', () => {
    const records = [{ benchmarkId: 'sid_pDqehtEoiw', score: 1 }];
    resolveNonEntityForeignKeys('personnel', records, slugMap);
    expect(records[0].benchmarkId).toBe('sid_pDqehtEoiw');
  });

  it('does not modify modelId (an entity FK, not a non-entity FK)', () => {
    // modelId FKs `entities.stable_id`, so it must stay sid_-prefixed.
    const records = [{ benchmarkId: 'sid_pDqehtEoiw', modelId: 'sid_cMKB5i2WZQ' }];
    resolveNonEntityForeignKeys('benchmark-results', records, slugMap);
    expect(records[0].modelId).toBe('sid_cMKB5i2WZQ');
  });
});
