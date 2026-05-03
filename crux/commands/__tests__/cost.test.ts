/**
 * Tests for `crux sys cost report` — QUA-1068.
 *
 * Covers the input-translation helpers (period strings → YYYYMMDD,
 * --by aliases). The actual ccusage subprocess is exercised by the
 * integration smoke test (`pnpm crux sys cost report`).
 */

import { describe, it, expect } from 'vitest';
import { normalizeBy, resolveDate } from '../cost.ts';

describe('normalizeBy', () => {
  it('defaults to daily when undefined', () => {
    expect(normalizeBy(undefined)).toBe('daily');
  });

  it('maps day -> daily', () => {
    expect(normalizeBy('day')).toBe('daily');
    expect(normalizeBy('daily')).toBe('daily');
  });

  it('maps week -> weekly, month -> monthly', () => {
    expect(normalizeBy('week')).toBe('weekly');
    expect(normalizeBy('weekly')).toBe('weekly');
    expect(normalizeBy('month')).toBe('monthly');
    expect(normalizeBy('monthly')).toBe('monthly');
  });

  it('maps block -> blocks', () => {
    expect(normalizeBy('block')).toBe('blocks');
    expect(normalizeBy('blocks')).toBe('blocks');
  });

  it('keeps session as session', () => {
    expect(normalizeBy('session')).toBe('session');
  });

  it('is case insensitive', () => {
    expect(normalizeBy('SESSION')).toBe('session');
    expect(normalizeBy('Daily')).toBe('daily');
  });

  it('throws on invalid value', () => {
    expect(() => normalizeBy('foobar')).toThrow(/Invalid --by/);
  });
});

describe('resolveDate', () => {
  // Use local-time construction so tests are TZ-agnostic. resolveDate uses
  // `getDate`/`getMonth`/`getFullYear` (local) so the fixture must match.
  const FIXED = new Date(2026, 4, 2); // May 2, 2026 (month is 0-indexed)

  it('returns undefined for undefined input', () => {
    expect(resolveDate(undefined, FIXED)).toBeUndefined();
  });

  it('passes through a literal YYYYMMDD', () => {
    expect(resolveDate('20260415', FIXED)).toBe('20260415');
  });

  it('converts Nd to N-days-ago in YYYYMMDD', () => {
    // 2026-05-02 - 7d = 2026-04-25
    expect(resolveDate('7d', FIXED)).toBe('20260425');
    // 2026-05-02 - 1d = 2026-05-01
    expect(resolveDate('1d', FIXED)).toBe('20260501');
  });

  it('converts Nw to N*7-days-ago', () => {
    // 2026-05-02 - 14d = 2026-04-18
    expect(resolveDate('2w', FIXED)).toBe('20260418');
  });

  it('handles month-boundary subtraction', () => {
    // 2026-03-01 - 1d = 2026-02-28
    expect(resolveDate('1d', new Date(2026, 2, 1))).toBe('20260228');
  });

  it('throws on garbage input', () => {
    expect(() => resolveDate('xyz', FIXED)).toThrow(/Invalid date/);
    expect(() => resolveDate('12345', FIXED)).toThrow(/Invalid date/);
  });

  it('rejects unsupported units', () => {
    expect(() => resolveDate('5h', FIXED)).toThrow(/Invalid date/);
    expect(() => resolveDate('5m', FIXED)).toThrow(/Invalid date/);
  });
});
