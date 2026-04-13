import { describe, it, expect } from 'vitest';
import { extractFixesIds } from '../audit.ts';

describe('extractFixesIds', () => {
  it('extracts Fixes QUA-NNN references', () => {
    const body = `## Summary\n\nFixes QUA-184\nCloses QUA-185\nResolves QUA-186`;
    expect(extractFixesIds(body)).toEqual(['QUA-184', 'QUA-185', 'QUA-186']);
  });

  it('is case-insensitive and dedupes', () => {
    const body = `fixes qua-42\nFixes QUA-42\nFIXES QUA-42`;
    expect(extractFixesIds(body)).toEqual(['QUA-42']);
  });

  it('does not match bare QUA-NNN without a keyword', () => {
    const body = `This is about QUA-999 but not closing it.`;
    expect(extractFixesIds(body)).toEqual([]);
  });

  it('returns empty for no matches', () => {
    expect(extractFixesIds('')).toEqual([]);
    expect(extractFixesIds('nothing to see')).toEqual([]);
  });

  it('handles multiple references with mixed separators', () => {
    const body = `Fixes QUA-1
      Closes   QUA-2
Resolves\tQUA-3`;
    expect(extractFixesIds(body)).toEqual(['QUA-1', 'QUA-2', 'QUA-3']);
  });
});
