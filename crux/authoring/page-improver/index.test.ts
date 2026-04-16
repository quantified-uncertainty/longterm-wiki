/**
 * Tests for the page-improver CLI entry point.
 *
 * Currently covers the --min-sources flag parser, which exists to prevent
 * the silent-degradation failure mode QUA-315 introduced — passing
 * parseInt('foo') (= NaN) through to the gate would silently disable it
 * because `NaN > 0` is false.
 */

import { describe, it, expect } from 'vitest';
import { parseMinSources } from './index.ts';

describe('parseMinSources', () => {
  it('returns undefined when the flag is omitted', () => {
    expect(parseMinSources(undefined)).toBeUndefined();
  });

  it('parses a valid positive integer', () => {
    expect(parseMinSources('5')).toBe(5);
  });

  it('parses 0 as a valid value (gate-disable signal)', () => {
    expect(parseMinSources('0')).toBe(0);
  });

  it('parses a numeric value passed as a number (defensive — argparser produces strings but kwargs caller may not)', () => {
    expect(parseMinSources(3)).toBe(3);
  });

  it('throws on a non-numeric string (would otherwise become NaN and silently disable the gate)', () => {
    expect(() => parseMinSources('foo')).toThrow(/non-negative integer/);
  });

  it('throws on a negative integer (would silently disable the gate)', () => {
    expect(() => parseMinSources('-1')).toThrow(/non-negative integer/);
  });

  it('throws on the empty string', () => {
    expect(() => parseMinSources('')).toThrow(/non-negative integer/);
  });

  it('throws on Infinity', () => {
    expect(() => parseMinSources('Infinity')).toThrow(/non-negative integer/);
  });

  it('echoes the bad value in the error message for debuggability', () => {
    expect(() => parseMinSources('foo')).toThrow(/got: foo/);
  });
});
