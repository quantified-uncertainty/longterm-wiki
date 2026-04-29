/**
 * Unit tests for parseAndValidate (QUA-158 / Tier 3).
 *
 * Note: parseJsonFromLlm itself is tested at
 * crux/authoring/page-improver/phases/json-parsing.test.ts. These tests cover
 * the additional Zod-validation layer that parseAndValidate adds on top.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { parseAndValidate } from './json-parsing.ts';

const Schema = z.object({
  verdict: z.enum(['confirmed', 'contradicted', 'unverifiable']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().optional(),
});

type Result = z.infer<typeof Schema>;

const fallback = (): Result => ({
  verdict: 'unverifiable',
  confidence: 0,
  reasoning: 'fallback',
});

describe('parseAndValidate', () => {
  it('returns the validated value on a well-formed response', () => {
    const raw = '{"verdict":"confirmed","confidence":0.9,"reasoning":"matches source"}';
    const result = parseAndValidate(raw, Schema, 'test', fallback);
    expect(result).toEqual({
      verdict: 'confirmed',
      confidence: 0.9,
      reasoning: 'matches source',
    });
  });

  it('strips markdown code fences before validating', () => {
    const raw = '```json\n{"verdict":"contradicted","confidence":0.8}\n```';
    const result = parseAndValidate(raw, Schema, 'test', fallback);
    expect(result.verdict).toBe('contradicted');
    expect(result.confidence).toBe(0.8);
  });

  it('returns fallback when JSON parses but fails schema validation', () => {
    // 'maybe' is not in the verdict enum — must trigger fallback, not pass through
    const raw = '{"verdict":"maybe","confidence":0.5}';
    const result = parseAndValidate(raw, Schema, 'test', fallback);
    expect(result.verdict).toBe('unverifiable');
    expect(result.reasoning).toBe('fallback');
  });

  it('returns fallback when confidence is out of range', () => {
    const raw = '{"verdict":"confirmed","confidence":2.5}';
    const result = parseAndValidate(raw, Schema, 'test', fallback);
    // confidence > 1 violates the schema; must fall back rather than pass through
    expect(result.confidence).toBe(0);
    expect(result.verdict).toBe('unverifiable');
  });

  it('returns fallback when JSON cannot be parsed at all', () => {
    const raw = 'this is not JSON, just garbage from the LLM';
    const result = parseAndValidate(raw, Schema, 'test', fallback);
    expect(result.verdict).toBe('unverifiable');
    expect(result.confidence).toBe(0);
  });

  it('returns fallback when an array is required but the response is an object', () => {
    const ArraySchema = z.array(z.object({ id: z.number() }));
    const arrayFallback = (): Array<{ id: number }> => [];
    const raw = '{"id": 5}';
    const result = parseAndValidate(raw, ArraySchema, 'test', arrayFallback);
    expect(result).toEqual([]);
  });

  it('passes through optional fields that are absent', () => {
    const raw = '{"verdict":"confirmed","confidence":0.7}';
    const result = parseAndValidate(raw, Schema, 'test', fallback);
    expect(result.verdict).toBe('confirmed');
    expect(result.reasoning).toBeUndefined();
  });

  it('validates extracted JSON when surrounded by prose', () => {
    const raw = 'Here is my analysis:\n{"verdict":"confirmed","confidence":0.95}\nThanks!';
    const result = parseAndValidate(raw, Schema, 'test', fallback);
    expect(result.verdict).toBe('confirmed');
  });

  it('returns fallback if the raw response is empty', () => {
    const result = parseAndValidate('', Schema, 'test', fallback);
    expect(result.verdict).toBe('unverifiable');
  });

  it('passes the raw response and error to the fallback factory', () => {
    let capturedRaw: string | undefined;
    let capturedError: string | undefined;
    const recordingFallback = (raw: string, error?: string): Result => {
      capturedRaw = raw;
      capturedError = error;
      return fallback();
    };
    parseAndValidate('{"verdict":"maybe","confidence":0.5}', Schema, 'test', recordingFallback);
    expect(capturedRaw).toContain('"maybe"');
    expect(capturedError).toBeTruthy();
  });
});
