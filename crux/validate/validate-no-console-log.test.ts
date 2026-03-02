import { describe, it, expect } from 'vitest';
import { runCheck } from './validate-no-console-log.ts';

describe('validate-no-console-log', () => {
  it('passes on the current codebase (all violations fixed)', () => {
    // This test acts as a regression guard: if someone adds console.log
    // to wiki-server or groundskeeper source, this test will fail.
    const result = runCheck();
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
  });
});
