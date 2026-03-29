import { describe, it, expect } from 'vitest';
import { checkLine } from '../validate-manual-api-types.ts';

describe('validate-manual-api-types — violation detection', () => {
  it('flags inline apiRequest<{ type parameter', () => {
    const line =
      "  const result = await apiRequest<{ updated: number; total: number }>('POST', '/api/claims/verdicts', { verdicts });";
    expect(checkLine(line)).toBe('violation');
  });

  it('flags multiline start of inline type', () => {
    expect(checkLine('  const result = await apiRequest<{')).toBe('violation');
  });

  it('passes apiRequest without type parameter', () => {
    const line = "  const result = await apiRequest('POST', '/api/claims/verdicts', { verdicts });";
    expect(checkLine(line)).toBe('clean');
  });

  it('passes apiRequest with named type parameter', () => {
    expect(checkLine('  const result = await apiRequest<ClaimVerdictsResponse>(')).toBe('clean');
  });

  it('passes apiRequest with generic type variable', () => {
    expect(checkLine('  const result = await apiRequest<T>(')).toBe('clean');
  });

  it('skips comment lines (not a violation)', () => {
    expect(checkLine('  // apiRequest<{ example in comment')).toBe('clean');
    expect(checkLine('  /* apiRequest<{ block comment */')).toBe('clean');
    expect(checkLine('  * apiRequest<{ jsdoc line')).toBe('clean');
  });
});

describe('validate-manual-api-types — suppression', () => {
  it('suppresses violation when // api-type-ok comment is present', () => {
    const line = "  const r = await apiRequest<{ ok: boolean }>('GET', '/health'); // api-type-ok";
    expect(checkLine(line)).toBe('suppressed');
  });

  it('does not suppress without the comment', () => {
    const line = "  const r = await apiRequest<{ ok: boolean }>('GET', '/health');";
    expect(checkLine(line)).toBe('violation');
  });

  it('does not suppress when api-type-ok appears in code (not a comment)', () => {
    // e.g., a variable name containing the substring
    const line = "  const apiTypeOkResult = await apiRequest<{ ok: boolean }>('GET', '/health');";
    expect(checkLine(line)).toBe('violation');
  });

  it('suppresses with extra spacing in comment', () => {
    const line = "  const r = await apiRequest<{ ok: boolean }>('GET', '/health'); //  api-type-ok";
    expect(checkLine(line)).toBe('suppressed');
  });
});
