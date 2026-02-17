import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getApiKey } from './api-keys.ts';

describe('getApiKey', () => {
  const TEST_VAR = '__TEST_API_KEY__';

  afterEach(() => {
    delete process.env[TEST_VAR];
  });

  it('returns undefined when env var is not set', () => {
    expect(getApiKey(TEST_VAR)).toBeUndefined();
  });

  it('returns undefined when env var is empty', () => {
    process.env[TEST_VAR] = '';
    expect(getApiKey(TEST_VAR)).toBeUndefined();
  });

  it('returns the key as-is when no quotes', () => {
    process.env[TEST_VAR] = 'sk-ant-abc123';
    expect(getApiKey(TEST_VAR)).toBe('sk-ant-abc123');
  });

  it('strips surrounding double quotes', () => {
    process.env[TEST_VAR] = '"sk-ant-abc123"';
    expect(getApiKey(TEST_VAR)).toBe('sk-ant-abc123');
  });

  it('strips surrounding single quotes', () => {
    process.env[TEST_VAR] = "'sk-ant-abc123'";
    expect(getApiKey(TEST_VAR)).toBe('sk-ant-abc123');
  });

  it('strips leading quote only (common misconfiguration)', () => {
    process.env[TEST_VAR] = '"sk-or-v1-abc123';
    expect(getApiKey(TEST_VAR)).toBe('sk-or-v1-abc123');
  });

  it('strips surrounding whitespace', () => {
    process.env[TEST_VAR] = '  sk-ant-abc123  ';
    expect(getApiKey(TEST_VAR)).toBe('sk-ant-abc123');
  });

  it('strips quotes and whitespace together', () => {
    process.env[TEST_VAR] = ' "sk-ant-abc123" ';
    expect(getApiKey(TEST_VAR)).toBe('sk-ant-abc123');
  });

  it('returns undefined when only quotes and whitespace', () => {
    process.env[TEST_VAR] = '" "';
    expect(getApiKey(TEST_VAR)).toBeUndefined();
  });
});
