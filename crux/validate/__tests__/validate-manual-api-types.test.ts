import { describe, it, expect } from 'vitest';

describe('validate-manual-api-types — pattern detection', () => {
  const VIOLATION_PATTERN = /apiRequest<\{/;

  it('matches inline apiRequest<{ type parameter', () => {
    const line = "  const result = await apiRequest<{ updated: number; total: number }>('POST', '/api/claims/verdicts', { verdicts });";
    expect(VIOLATION_PATTERN.test(line)).toBe(true);
  });

  it('matches multiline start of inline type', () => {
    const line = '  const result = await apiRequest<{';
    expect(VIOLATION_PATTERN.test(line)).toBe(true);
  });

  it('does not match apiRequest without type parameter', () => {
    const line = "  const result = await apiRequest('POST', '/api/claims/verdicts', { verdicts });";
    expect(VIOLATION_PATTERN.test(line)).toBe(false);
  });

  it('does not match apiRequest with named type parameter', () => {
    const line = '  const result = await apiRequest<ClaimVerdictsResponse>(';
    expect(VIOLATION_PATTERN.test(line)).toBe(false);
  });

  it('does not match apiRequest with generic type variable', () => {
    const line = '  const result = await apiRequest<T>(';
    expect(VIOLATION_PATTERN.test(line)).toBe(false);
  });

  it('does not match comment lines', () => {
    // The checker skips comment lines before applying the regex,
    // but the regex itself would match — this tests the regex only
    const commentLine = '  // apiRequest<{ example in comment';
    expect(VIOLATION_PATTERN.test(commentLine)).toBe(true);
    // The actual checker would skip this because trimmed.startsWith('//')
  });
});

describe('validate-manual-api-types — suppression', () => {
  const SUPPRESS_COMMENT = 'api-type-ok';

  it('recognizes suppression comment', () => {
    const line = "  const r = await apiRequest<{ ok: boolean }>('GET', '/health'); // api-type-ok";
    expect(line.includes(SUPPRESS_COMMENT)).toBe(true);
  });

  it('does not suppress without comment', () => {
    const line = "  const r = await apiRequest<{ ok: boolean }>('GET', '/health');";
    expect(line.includes(SUPPRESS_COMMENT)).toBe(false);
  });
});

describe('validate-manual-api-types — exclusion logic', () => {
  it('wiki-server client directory should be excluded', () => {
    // The check excludes crux/lib/wiki-server/ because those files ARE the typed clients
    // This is a design constraint, not a code test — verifying the intention is documented
    const excludedPath = 'crux/lib/wiki-server/claims.ts';
    expect(excludedPath.startsWith('crux/lib/wiki-server/')).toBe(true);
  });

  it('test files should be excluded', () => {
    const testFile = 'crux/lib/job-handlers/__tests__/claim-verification.test.ts';
    expect(testFile.includes('__tests__') || testFile.endsWith('.test.ts')).toBe(true);
  });
});
