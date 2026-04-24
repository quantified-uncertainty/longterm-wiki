import { describe, it, expect } from 'vitest';
import { formatMoney, formatCompactAmount } from '../routes/shared/format-currency.js';

describe('formatMoney', () => {
  it('formats USD with $ symbol', () => {
    expect(formatMoney(1_000_000, 'USD')).toBe('$1,000,000');
  });

  it('formats EUR with € symbol', () => {
    expect(formatMoney(1_000_000, 'EUR')).toBe('€1,000,000');
  });

  it('formats GBP with £ symbol', () => {
    expect(formatMoney(500_000, 'GBP')).toBe('£500,000');
  });

  it('formats JPY with ¥ symbol', () => {
    expect(formatMoney(100_000_000, 'JPY')).toBe('¥100,000,000');
  });

  it('lowercases currency code input and still formats correctly', () => {
    expect(formatMoney(1000, 'eur')).toBe('€1,000');
  });

  it('defaults to USD when currency is null', () => {
    expect(formatMoney(500, null)).toBe('$500');
  });

  it('defaults to USD when currency is undefined', () => {
    expect(formatMoney(500, undefined)).toBe('$500');
  });

  it('returns null for null amount', () => {
    expect(formatMoney(null, 'USD')).toBeNull();
  });

  it('returns null for undefined amount', () => {
    expect(formatMoney(undefined, 'USD')).toBeNull();
  });

  it('accepts string-encoded amounts (Drizzle numeric)', () => {
    expect(formatMoney('2500000', 'USD')).toBe('$2,500,000');
  });

  it('returns null for non-numeric strings', () => {
    expect(formatMoney('not a number', 'USD')).toBeNull();
  });

  it('returns null for NaN', () => {
    expect(formatMoney(Number.NaN, 'USD')).toBeNull();
  });

  it('returns null for Infinity', () => {
    expect(formatMoney(Number.POSITIVE_INFINITY, 'USD')).toBeNull();
  });

  it('drops fractional cents for whole-unit display', () => {
    expect(formatMoney(1234.56, 'USD')).toBe('$1,235');
  });

  it('handles zero', () => {
    expect(formatMoney(0, 'USD')).toBe('$0');
  });

  it('handles negative amounts', () => {
    expect(formatMoney(-1000, 'USD')).toBe('-$1,000');
  });

  it('falls back to plain number formatting for malformed currency codes', () => {
    // Intl.NumberFormat throws RangeError when the currency code isn't a
    // well-formed 3-letter string. The helper must catch and return the
    // amount as a number-only string rather than crashing the sync handler.
    const result = formatMoney(1000, 'TOOLONG');
    expect(result).not.toBeNull();
    expect(result).toContain('1,000');
  });
});

describe('formatCompactAmount (QUA-673)', () => {
  it('compacts billions with USD prefix', () => {
    expect(formatCompactAmount(1_700_000_000, 'USD')).toBe('$1.7B');
  });

  it('compacts tens of billions', () => {
    expect(formatCompactAmount(70_000_000_000, 'USD')).toBe('$70B');
  });

  it('compacts hundreds of billions', () => {
    expect(formatCompactAmount(125_000_000_000, 'USD')).toBe('$125B');
  });

  it('compacts GBP with £ prefix', () => {
    expect(formatCompactAmount(1_325_000_000, 'GBP')).toBe('£1.3B');
  });

  it('compacts without a currency prefix when currency is null', () => {
    expect(formatCompactAmount(1_000_000_000, null)).toBe('1B');
  });

  it('compacts sub-billion values', () => {
    expect(formatCompactAmount(78_800, null)).toBe('78.8K');
    expect(formatCompactAmount(6_300_000, null)).toBe('6.3M');
  });

  it('accepts scientific notation strings', () => {
    expect(formatCompactAmount('7e+10', 'USD')).toBe('$70B');
    expect(formatCompactAmount('1.645e+11', 'USD')).toBe('$164.5B');
  });

  it('accepts plain numeric strings', () => {
    expect(formatCompactAmount('1700000000', 'USD')).toBe('$1.7B');
  });

  it('rejects non-numeric strings', () => {
    expect(formatCompactAmount('Menlo Park, CA', null)).toBeNull();
    expect(formatCompactAmount('1,700,000,000', null)).toBeNull();
    expect(formatCompactAmount('0.015–0.025', null)).toBeNull();
    expect(formatCompactAmount('sid_abc', null)).toBeNull();
  });

  it('returns null for null / undefined / NaN / Infinity', () => {
    expect(formatCompactAmount(null, 'USD')).toBeNull();
    expect(formatCompactAmount(undefined, 'USD')).toBeNull();
    expect(formatCompactAmount(Number.NaN, 'USD')).toBeNull();
    expect(formatCompactAmount(Number.POSITIVE_INFINITY, 'USD')).toBeNull();
  });

  it('handles zero', () => {
    expect(formatCompactAmount(0, 'USD')).toBe('$0');
    expect(formatCompactAmount(0, null)).toBe('0');
  });

  it('handles negative values', () => {
    // Intl keeps the minus sign before the currency symbol.
    const neg = formatCompactAmount(-1_700_000_000, 'USD');
    expect(neg).toBe('-$1.7B');
  });

  it('output never contains a bare 10+ digit run', () => {
    // Contract: this function must not produce raw large-digit strings that
    // would fail the render-audit regex in e2e/render-audit.spec.ts.
    const inputs = [1_000_000_000, 7e10, 1.25e11, 1.645e11, 2.0097e11, 70_000_000_000];
    for (const n of inputs) {
      const got = formatCompactAmount(n, 'USD');
      expect(got, `compact form of ${n}`).not.toMatch(/(?<![a-zA-Z_])\d{10,}(?![a-zA-Z])/);
    }
  });
});
