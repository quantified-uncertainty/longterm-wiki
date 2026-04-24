import { describe, it, expect } from 'vitest';
import { ensureSidPrefix } from './tools.ts';

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
