/**
 * Tests for record-fields.ts
 */
import { describe, it, expect } from 'vitest';
import { str, strOrNull, numOrNull, resolveName } from './record-fields.ts';

describe('str', () => {
  it('returns string values directly', () => {
    expect(str({ name: 'hello' }, 'name')).toBe('hello');
  });

  it('converts numbers to strings', () => {
    expect(str({ count: 42 }, 'count')).toBe('42');
  });

  it('returns empty string for null/undefined', () => {
    expect(str({ x: null }, 'x')).toBe('');
    expect(str({ x: undefined }, 'x')).toBe('');
    expect(str({}, 'missing')).toBe('');
  });

  it('converts booleans to strings', () => {
    expect(str({ flag: true }, 'flag')).toBe('true');
    expect(str({ flag: false }, 'flag')).toBe('false');
  });
});

describe('strOrNull', () => {
  it('returns string values', () => {
    expect(strOrNull({ name: 'hello' }, 'name')).toBe('hello');
  });

  it('returns null for null/undefined', () => {
    expect(strOrNull({ x: null }, 'x')).toBeNull();
    expect(strOrNull({ x: undefined }, 'x')).toBeNull();
    expect(strOrNull({}, 'missing')).toBeNull();
  });

  it('converts numbers to strings', () => {
    expect(strOrNull({ count: 42 }, 'count')).toBe('42');
  });

  it('converts empty string to string (not null)', () => {
    expect(strOrNull({ x: '' }, 'x')).toBe('');
  });
});

describe('numOrNull', () => {
  it('returns number values', () => {
    expect(numOrNull({ amount: 42 }, 'amount')).toBe(42);
  });

  it('returns null for non-number values', () => {
    expect(numOrNull({ amount: '42' }, 'amount')).toBeNull();
    expect(numOrNull({ amount: null }, 'amount')).toBeNull();
    expect(numOrNull({}, 'missing')).toBeNull();
  });

  it('returns 0 for numeric zero', () => {
    expect(numOrNull({ count: 0 }, 'count')).toBe(0);
  });

  it('returns NaN for NaN (it is typeof number)', () => {
    expect(numOrNull({ x: NaN }, 'x')).toBeNaN();
  });

  it('returns negative numbers', () => {
    expect(numOrNull({ x: -5 }, 'x')).toBe(-5);
  });
});

describe('resolveName', () => {
  it('returns the first non-empty string value found', () => {
    const item = { displayName: '', resolvedName: 'Alice', id: 'abc123' };
    expect(resolveName(item, 'displayName', 'resolvedName', 'id')).toBe('Alice');
  });

  it('returns (unknown) when no keys match', () => {
    expect(resolveName({}, 'a', 'b', 'c')).toBe('(unknown)');
  });

  it('returns (unknown) when all values are empty strings', () => {
    expect(resolveName({ a: '', b: '' }, 'a', 'b')).toBe('(unknown)');
  });

  it('returns (unknown) when all values are non-string', () => {
    expect(resolveName({ a: 42, b: null }, 'a', 'b')).toBe('(unknown)');
  });

  it('returns the first key that has a non-empty string', () => {
    const item = { a: null, b: 'Bob', c: 'Charlie' };
    expect(resolveName(item, 'a', 'b', 'c')).toBe('Bob');
  });

  it('returns (unknown) when no keys are provided', () => {
    expect(resolveName({ a: 'hello' })).toBe('(unknown)');
  });
});
