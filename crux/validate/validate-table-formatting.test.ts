import { describe, it, expect } from 'vitest';
import { runCheck } from './validate-table-formatting.ts';

describe('validate-table-formatting', () => {
  it('passes on the current codebase — directory tables use shared formatters', () => {
    // QUA-1006 regression guard: if someone adds new ad-hoc
    // .toLocaleString / .toLocaleDateString / Intl.NumberFormat calls to a
    // user-facing *-table.tsx without the table-formatting-ok marker, this
    // test will fail.
    const result = runCheck();
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
  });
});
