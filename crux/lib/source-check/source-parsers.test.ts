import { describe, it, expect } from 'vitest';
import { applyColumnMapping } from './source-parsers.ts';

describe('applyColumnMapping', () => {
  it('maps source columns to internal field names', () => {
    const rows = [{ Organization: 'MIRI', Amount: 50000 }];
    const mapping = { Organization: 'grantee', Amount: 'amount' };
    const result = applyColumnMapping(rows, mapping);
    expect(result[0]).toEqual({ grantee: 'MIRI', amount: 50000 });
  });

  it('keeps unmapped fields that do not collide with mapping targets', () => {
    const rows = [{ Organization: 'MIRI', Amount: 50000, extra: 'data' }];
    const mapping = { Organization: 'grantee', Amount: 'amount' };
    const result = applyColumnMapping(rows, mapping);
    expect(result[0]).toEqual({ grantee: 'MIRI', amount: 50000, extra: 'data' });
  });

  it('does NOT copy unmapped fields whose key collides with a mapping target', () => {
    // Source row has a field called 'amount' (lowercase) AND 'Amount' (capitalized).
    // The mapping maps 'Amount' → 'amount'. Without the fix, the unmapped 'amount'
    // field would overwrite the mapped value.
    const rows = [{ Amount: 50000, amount: 'wrong-value', grantee: 'should-be-dropped' }];
    const mapping = { Amount: 'amount', Organization: 'grantee' };
    const result = applyColumnMapping(rows, mapping);
    // 'Amount' is a mapping source → mapped to 'amount' with value 50000
    // 'amount' is NOT a mapping source, but IS a mapping target → should be skipped
    // 'grantee' is NOT a mapping source, but IS a mapping target → should be skipped
    expect(result[0]).toEqual({ amount: 50000 });
  });

  it('handles empty mapping gracefully', () => {
    const rows = [{ a: 1, b: 2 }];
    const result = applyColumnMapping(rows, {});
    expect(result[0]).toEqual({ a: 1, b: 2 });
  });
});
