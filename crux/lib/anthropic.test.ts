/**
 * Unit Tests for anthropic.ts pure functions
 */

import { describe, it, expect } from 'vitest';
import { parseJsonResponse, resolveModel, MODELS } from './anthropic.ts';

describe('resolveModel', () => {
  it('resolves "sonnet" to canonical model ID', () => {
    expect(resolveModel('sonnet')).toBe(MODELS.sonnet);
  });

  it('resolves "haiku" to canonical model ID', () => {
    expect(resolveModel('haiku')).toBe(MODELS.haiku);
  });

  it('resolves "opus" to canonical model ID', () => {
    expect(resolveModel('opus')).toBe(MODELS.opus);
  });

  it('resolves full model ID to canonical', () => {
    expect(resolveModel('claude-sonnet-4-20250514')).toBe(MODELS.sonnet);
  });

  it('resolves alternate model IDs', () => {
    expect(resolveModel('claude-sonnet-4-5-20250929')).toBe(MODELS.sonnet);
    expect(resolveModel('claude-sonnet-4-6')).toBe(MODELS.sonnet);
    expect(resolveModel('claude-opus-4-6')).toBe(MODELS.opus);
  });

  it('defaults to haiku for unknown model names', () => {
    expect(resolveModel('unknown-model')).toBe(MODELS.haiku);
  });
});

describe('parseJsonResponse', () => {
  it('parses plain JSON', () => {
    const result = parseJsonResponse('{"key": "value"}');
    expect(result).toEqual({ key: 'value' });
  });

  it('strips ```json code block wrapper', () => {
    const result = parseJsonResponse('```json\n{"key": "value"}\n```');
    expect(result).toEqual({ key: 'value' });
  });

  it('strips ``` code block wrapper', () => {
    const result = parseJsonResponse('```\n{"key": "value"}\n```');
    expect(result).toEqual({ key: 'value' });
  });

  it('handles whitespace around code blocks', () => {
    const result = parseJsonResponse('  ```json\n  {"key": "value"}  \n```  ');
    expect(result).toEqual({ key: 'value' });
  });

  it('parses arrays', () => {
    const result = parseJsonResponse('[1, 2, 3]');
    expect(result).toEqual([1, 2, 3]);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseJsonResponse('not json')).toThrow();
  });
});

