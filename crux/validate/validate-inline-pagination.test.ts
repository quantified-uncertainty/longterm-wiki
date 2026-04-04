import { describe, it, expect } from 'vitest';
import { checkLine, runCheck } from './validate-inline-pagination.ts';

describe('checkLine', () => {
  it('flags Math.min(Number(c.req.query( pattern', () => {
    const result = checkLine('    const limit = Math.min(Number(c.req.query("limit") || 50), 200);');
    expect(result.violation).toBe(true);
  });

  it('flags .limit(Number( pattern', () => {
    const result = checkLine('      .limit(Number(query.limit))');
    expect(result.violation).toBe(true);
  });

  it('flags .limit(parseInt( pattern', () => {
    const result = checkLine('      .limit(parseInt(query.limit, 10))');
    expect(result.violation).toBe(true);
  });

  it('allows clampedLimit usage', () => {
    const result = checkLine('  limit: clampedLimit(200, 50),');
    expect(result.violation).toBe(false);
  });

  it('allows hardcoded .limit(1)', () => {
    const result = checkLine('      .limit(1)');
    expect(result.violation).toBe(false);
  });

  it('allows .limit(limit) where limit is from schema', () => {
    const result = checkLine('      .limit(limit)');
    expect(result.violation).toBe(false);
  });

  it('skips comment lines', () => {
    const result = checkLine('// const limit = Math.min(Number(c.req.query("limit") || 50), 200);');
    expect(result.violation).toBe(false);
  });

  it('respects // pagination-ok suppression', () => {
    const result = checkLine('    const limit = Math.min(Number(c.req.query("limit") || 50), 200); // pagination-ok');
    expect(result.violation).toBe(false);
  });
});

describe('runCheck', () => {
  it('passes on the current codebase (all violations fixed)', () => {
    // This test acts as a regression guard: if someone adds inline limit clamping
    // to wiki-server routes, this test will fail.
    const result = runCheck();
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
  });
});
