import { describe, it, expect } from 'vitest';
import { formatMoney } from '../routes/shared/format-currency.js';

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
