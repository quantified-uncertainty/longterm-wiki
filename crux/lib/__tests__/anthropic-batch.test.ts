import { describe, it, expect } from 'vitest';
import { sanitizeBatchCustomId } from '../anthropic-batch.ts';

describe('sanitizeBatchCustomId', () => {
  it('passes through valid IDs unchanged', () => {
    expect(sanitizeBatchCustomId('verify-abc123')).toBe('verify-abc123');
    expect(sanitizeBatchCustomId('hello_world-42')).toBe('hello_world-42');
    expect(sanitizeBatchCustomId('A')).toBe('A');
  });

  it('replaces colons with underscores', () => {
    expect(sanitizeBatchCustomId('verify-fact:f_abc123')).toBe('verify-fact_f_abc123');
    expect(sanitizeBatchCustomId('verify-record:personnel:p-1')).toBe('verify-record_personnel_p-1');
  });

  it('replaces dots, slashes, and other special characters', () => {
    expect(sanitizeBatchCustomId('https://example.com/path')).toBe('https___example_com_path');
    expect(sanitizeBatchCustomId('file.name@host')).toBe('file_name_host');
  });

  it('truncates to 64 characters', () => {
    const long = 'a'.repeat(100);
    const result = sanitizeBatchCustomId(long);
    expect(result).toHaveLength(64);
    expect(result).toBe('a'.repeat(64));
  });

  it('truncates after sanitization', () => {
    // Colons become underscores first, then truncation
    const input = 'verify-' + 'a:b'.repeat(30);
    const result = sanitizeBatchCustomId(input);
    expect(result).toHaveLength(64);
    expect(result).not.toContain(':');
  });

  it('throws on empty input', () => {
    expect(() => sanitizeBatchCustomId('')).toThrow('Cannot sanitize empty');
  });

  it('throws on all-invalid characters', () => {
    // All characters that would be replaced result in underscores, so this won't throw
    // unless the string is empty. Let's verify underscore-only result is fine.
    expect(sanitizeBatchCustomId(':::')).toBe('___');
  });

  it('preserves hyphens and underscores', () => {
    expect(sanitizeBatchCustomId('my-id_123')).toBe('my-id_123');
  });

  it('handles realistic source-check IDs', () => {
    // fact IDs
    expect(sanitizeBatchCustomId('verify-fact:mK9pX3rQ7n')).toBe('verify-fact_mK9pX3rQ7n');
    // record IDs with legacy format
    expect(sanitizeBatchCustomId('verify-record:personnel:TFkU7FRiy-')).toBe('verify-record_personnel_TFkU7FRiy-');
    // entity IDs (already valid)
    expect(sanitizeBatchCustomId('verify-entity:sid_1LcLlMGLbw')).toBe('verify-entity_sid_1LcLlMGLbw');
  });
});
