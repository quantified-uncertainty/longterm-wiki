import { describe, it, expect } from 'vitest';
import { normalizeClosesSyntax } from './pr.ts';

describe('normalizeClosesSyntax', () => {
  it('rewrites comma-separated Closes to one-per-line', () => {
    const { result, fixed } = normalizeClosesSyntax('Closes #1, #2, #3');
    expect(result).toBe('Closes #1\nCloses #2\nCloses #3');
    expect(fixed).toBe(1);
  });

  it('handles Fixes keyword', () => {
    const { result } = normalizeClosesSyntax('Fixes #10, #20');
    expect(result).toBe('Fixes #10\nFixes #20');
  });

  it('handles Resolves keyword', () => {
    const { result } = normalizeClosesSyntax('Resolves #5, #6, #7');
    expect(result).toBe('Resolves #5\nResolves #6\nResolves #7');
  });

  it('handles "and" separator', () => {
    const { result } = normalizeClosesSyntax('Closes #1 and #2');
    expect(result).toBe('Closes #1\nCloses #2');
  });

  it('leaves already-correct one-per-line format unchanged', () => {
    const input = 'Closes #1\nCloses #2\nCloses #3';
    const { result, fixed } = normalizeClosesSyntax(input);
    expect(result).toBe(input);
    expect(fixed).toBe(0);
  });

  it('leaves single Closes unchanged', () => {
    const input = 'Closes #42';
    const { result, fixed } = normalizeClosesSyntax(input);
    expect(result).toBe(input);
    expect(fixed).toBe(0);
  });

  it('handles mixed content around Closes lines', () => {
    const input = '## Summary\nSome text\n\nCloses #1, #2\n\nMore text';
    const { result } = normalizeClosesSyntax(input);
    expect(result).toBe('## Summary\nSome text\n\nCloses #1\nCloses #2\n\nMore text');
  });

  it('handles numbers without # prefix', () => {
    const { result } = normalizeClosesSyntax('Closes #1, 2, 3');
    expect(result).toBe('Closes #1\nCloses #2\nCloses #3');
  });
});
