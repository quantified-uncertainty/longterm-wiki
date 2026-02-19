import { describe, it, expect } from 'vitest';
import {
  parseQuoteExtractionResponse,
  parseAccuracyCheckResponse,
  truncateSource,
  stripCodeFences,
  VALID_ACCURACY_VERDICTS,
} from './quote-extractor.ts';

describe('stripCodeFences', () => {
  it('strips ```json prefix and ``` suffix', () => {
    expect(stripCodeFences('```json\n{"a": 1}\n```')).toBe('{"a": 1}');
  });

  it('handles case-insensitive JSON fence', () => {
    expect(stripCodeFences('```JSON\n{"a": 1}\n```')).toBe('{"a": 1}');
  });

  it('returns plain JSON as-is', () => {
    expect(stripCodeFences('{"a": 1}')).toBe('{"a": 1}');
  });

  it('handles trailing whitespace after closing fence', () => {
    expect(stripCodeFences('```json\n{"a": 1}\n```  ')).toBe('{"a": 1}');
  });

  it('only strips fences at start/end, not mid-content', () => {
    const input = '```json\n{"code": "```example```"}\n```';
    const result = stripCodeFences(input);
    expect(result).toContain('"code"');
  });
});

describe('truncateSource', () => {
  it('returns short text unchanged', () => {
    expect(truncateSource('short text')).toBe('short text');
  });

  it('truncates text over 50K chars with marker', () => {
    const long = 'a'.repeat(60_000);
    const result = truncateSource(long);
    expect(result.length).toBeLessThan(60_000);
    expect(result).toContain('[... truncated ...]');
  });

  it('does not truncate text at exactly 50K chars', () => {
    const exact = 'a'.repeat(50_000);
    expect(truncateSource(exact)).toBe(exact);
  });
});

describe('parseQuoteExtractionResponse', () => {
  it('parses valid JSON response', () => {
    const response = '{"quote": "The sky is blue.", "location": "paragraph 2", "confidence": 0.9}';
    const result = parseQuoteExtractionResponse(response);
    expect(result.quote).toBe('The sky is blue.');
    expect(result.location).toBe('paragraph 2');
    expect(result.confidence).toBe(0.9);
  });

  it('parses response wrapped in markdown code fences', () => {
    const response = '```json\n{"quote": "test", "location": "intro", "confidence": 0.8}\n```';
    const result = parseQuoteExtractionResponse(response);
    expect(result.quote).toBe('test');
    expect(result.confidence).toBe(0.8);
  });

  it('handles missing fields with defaults', () => {
    const result = parseQuoteExtractionResponse('{}');
    expect(result.quote).toBe('');
    expect(result.location).toBe('unknown');
    expect(result.confidence).toBe(0);
  });

  it('clamps confidence to [0, 1]', () => {
    const over = parseQuoteExtractionResponse('{"confidence": 1.5}');
    expect(over.confidence).toBe(1);

    const under = parseQuoteExtractionResponse('{"confidence": -0.3}');
    expect(under.confidence).toBe(0);
  });

  it('returns fallback on invalid JSON', () => {
    const result = parseQuoteExtractionResponse('not json at all');
    expect(result.quote).toBe('');
    expect(result.location).toBe('unknown');
    expect(result.confidence).toBe(0);
  });

  it('returns fallback on empty content', () => {
    const result = parseQuoteExtractionResponse('');
    expect(result.quote).toBe('');
    expect(result.confidence).toBe(0);
  });

  it('handles non-numeric confidence gracefully', () => {
    const result = parseQuoteExtractionResponse('{"confidence": "high"}');
    expect(result.confidence).toBe(0);
  });
});

describe('parseAccuracyCheckResponse', () => {
  it('parses a fully valid accurate response', () => {
    const response = JSON.stringify({
      verdict: 'accurate',
      score: 0.95,
      issues: [],
      supporting_quotes: ['The report states XYZ.'],
      verification_difficulty: 'Single sentence confirms the claim',
    });
    const result = parseAccuracyCheckResponse(response);
    expect(result.verdict).toBe('accurate');
    expect(result.score).toBe(0.95);
    expect(result.issues).toEqual([]);
    expect(result.supportingQuotes).toEqual(['The report states XYZ.']);
    expect(result.verificationDifficulty).toBe('Single sentence confirms the claim');
  });

  it('parses an inaccurate response with issues', () => {
    const response = JSON.stringify({
      verdict: 'inaccurate',
      score: 0.3,
      issues: ['Wrong date: claim says 2020, source says 2019', 'Dollar amount differs'],
      supporting_quotes: ['In 2019, the program launched...', 'Funding was $5M, not $10M'],
      verification_difficulty: 'Required cross-referencing two paragraphs',
    });
    const result = parseAccuracyCheckResponse(response);
    expect(result.verdict).toBe('inaccurate');
    expect(result.issues).toHaveLength(2);
    expect(result.supportingQuotes).toHaveLength(2);
  });

  it('validates verdict against allowed values', () => {
    for (const v of VALID_ACCURACY_VERDICTS) {
      const result = parseAccuracyCheckResponse(JSON.stringify({ verdict: v }));
      expect(result.verdict).toBe(v);
    }
  });

  it('falls back to not_verifiable for unknown verdict', () => {
    const result = parseAccuracyCheckResponse(JSON.stringify({ verdict: 'maybe_wrong' }));
    expect(result.verdict).toBe('not_verifiable');
  });

  it('clamps score to [0, 1]', () => {
    const over = parseAccuracyCheckResponse(JSON.stringify({ score: 2.5 }));
    expect(over.score).toBe(1);

    const under = parseAccuracyCheckResponse(JSON.stringify({ score: -1 }));
    expect(under.score).toBe(0);
  });

  it('defaults score to 0.5 when missing or non-numeric', () => {
    const missing = parseAccuracyCheckResponse('{}');
    expect(missing.score).toBe(0.5);

    const stringScore = parseAccuracyCheckResponse(JSON.stringify({ score: 'high' }));
    expect(stringScore.score).toBe(0.5);
  });

  it('filters out non-string and empty issues', () => {
    const response = JSON.stringify({
      verdict: 'minor_issues',
      issues: ['real issue', '', 42, null, 'another issue'],
    });
    const result = parseAccuracyCheckResponse(response);
    expect(result.issues).toEqual(['real issue', 'another issue']);
  });

  it('filters out non-string and empty supporting quotes', () => {
    const response = JSON.stringify({
      verdict: 'accurate',
      supporting_quotes: ['valid quote', '', null, 123, 'another quote'],
    });
    const result = parseAccuracyCheckResponse(response);
    expect(result.supportingQuotes).toEqual(['valid quote', 'another quote']);
  });

  it('handles missing issues/supporting_quotes arrays', () => {
    const result = parseAccuracyCheckResponse(JSON.stringify({ verdict: 'accurate' }));
    expect(result.issues).toEqual([]);
    expect(result.supportingQuotes).toEqual([]);
  });

  it('handles non-array issues field', () => {
    const result = parseAccuracyCheckResponse(JSON.stringify({ issues: 'not an array' }));
    expect(result.issues).toEqual([]);
  });

  it('defaults verificationDifficulty to empty string', () => {
    const result = parseAccuracyCheckResponse('{}');
    expect(result.verificationDifficulty).toBe('');
  });

  it('returns fallback on invalid JSON', () => {
    const result = parseAccuracyCheckResponse('This is not JSON');
    expect(result.verdict).toBe('not_verifiable');
    expect(result.score).toBe(0.5);
    expect(result.issues).toEqual(['Failed to parse LLM response']);
    expect(result.supportingQuotes).toEqual([]);
  });

  it('returns fallback on empty content', () => {
    const result = parseAccuracyCheckResponse('');
    expect(result.verdict).toBe('not_verifiable');
    expect(result.issues).toEqual(['Failed to parse LLM response']);
  });

  it('parses response wrapped in code fences', () => {
    const response = '```json\n' + JSON.stringify({
      verdict: 'accurate',
      score: 0.9,
      issues: [],
      supporting_quotes: ['test'],
      verification_difficulty: 'easy',
    }) + '\n```';
    const result = parseAccuracyCheckResponse(response);
    expect(result.verdict).toBe('accurate');
    expect(result.score).toBe(0.9);
  });
});
