import { describe, it, expect } from 'vitest';
import { hashId, contentHash } from './hash-utils.ts';

describe('hashId', () => {
  it('returns a 16-character hex string', () => {
    const result = hashId('https://example.com');
    expect(result).toHaveLength(16);
    expect(result).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic (same input = same output)', () => {
    expect(hashId('test-input')).toBe(hashId('test-input'));
  });

  it('produces different outputs for different inputs', () => {
    expect(hashId('input-a')).not.toBe(hashId('input-b'));
  });

  it('matches known SHA256 prefix for "https://example.com"', () => {
    expect(hashId('https://example.com')).toBe('100680ad546ce6a5');
  });
});

describe('contentHash', () => {
  it('returns a 32-character hex string', () => {
    const result = contentHash('hello world');
    expect(result).toHaveLength(32);
    expect(result).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is deterministic (same input = same output)', () => {
    expect(contentHash('test content')).toBe(contentHash('test content'));
  });

  it('produces different outputs for different inputs', () => {
    expect(contentHash('content-a')).not.toBe(contentHash('content-b'));
  });

  it('matches known MD5 hash for "hello world"', () => {
    expect(contentHash('hello world')).toBe('5eb63bbbe01eeed093cb22bb8f5acdc3');
  });
});
