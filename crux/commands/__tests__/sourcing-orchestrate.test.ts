/**
 * Tests for sourcing orchestrator's Zod schema parsing and verdict validation.
 *
 * Tests the LlmResponseSchema (batch JSON parsing) and validateVerdict function
 * from crux/lib/sourcing/llm-checker.ts — the core parsing logic used by
 * the orchestrator when processing LLM responses.
 */
import { describe, it, expect } from 'vitest';
import { LlmResponseSchema, validateVerdict } from '../../lib/sourcing/llm-checker.ts';

// ── LlmResponseSchema parsing ───────────────────────────────────────

describe('LlmResponseSchema', () => {
  describe('valid responses', () => {
    it('parses a fully-specified response', () => {
      const input = {
        verdict: 'confirmed',
        confidence: 0.95,
        extracted_value: '$2.5 billion',
        reasoning: 'The source states the funding amount is $2.5 billion.',
      };
      const result = LlmResponseSchema.parse(input);
      expect(result).toEqual(input);
    });

    it('parses boundary confidence values', () => {
      expect(LlmResponseSchema.parse({ verdict: 'confirmed', confidence: 0 }).confidence).toBe(0);
      expect(LlmResponseSchema.parse({ verdict: 'confirmed', confidence: 1 }).confidence).toBe(1);
      expect(LlmResponseSchema.parse({ verdict: 'confirmed', confidence: 0.001 }).confidence).toBe(0.001);
      expect(LlmResponseSchema.parse({ verdict: 'confirmed', confidence: 0.999 }).confidence).toBe(0.999);
    });

    it('accepts empty strings for extracted_value and reasoning', () => {
      const result = LlmResponseSchema.parse({
        verdict: 'unverifiable',
        confidence: 0.3,
        extracted_value: '',
        reasoning: '',
      });
      expect(result.extracted_value).toBe('');
      expect(result.reasoning).toBe('');
    });
  });

  describe('defaults for missing fields', () => {
    it('defaults confidence to 0.5 when missing', () => {
      const result = LlmResponseSchema.parse({
        verdict: 'confirmed',
        extracted_value: 'some value',
        reasoning: 'some reasoning',
      });
      expect(result.confidence).toBe(0.5);
    });

    it('defaults extracted_value to empty string when missing', () => {
      const result = LlmResponseSchema.parse({
        verdict: 'confirmed',
        confidence: 0.8,
        reasoning: 'some reasoning',
      });
      expect(result.extracted_value).toBe('');
    });

    it('defaults reasoning to empty string when missing', () => {
      const result = LlmResponseSchema.parse({
        verdict: 'confirmed',
        confidence: 0.8,
        extracted_value: 'some value',
      });
      expect(result.reasoning).toBe('');
    });

    it('defaults verdict to unverifiable when missing', () => {
      const result = LlmResponseSchema.parse({
        confidence: 0.8,
        extracted_value: 'some value',
        reasoning: 'some reasoning',
      });
      expect(result.verdict).toBe('unverifiable');
    });

    it('defaults all fields when given an empty object', () => {
      const result = LlmResponseSchema.parse({});
      expect(result).toEqual({
        verdict: 'unverifiable',
        confidence: 0.5,
        extracted_value: '',
        reasoning: '',
      });
    });
  });

  describe('confidence validation', () => {
    it('rejects confidence greater than 1', () => {
      const result = LlmResponseSchema.safeParse({
        verdict: 'confirmed',
        confidence: 1.1,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const confidenceIssue = result.error.issues.find(
          (i) => i.path.includes('confidence')
        );
        expect(confidenceIssue).toBeDefined();
        expect(confidenceIssue!.code).toBe('too_big');
      }
    });

    it('rejects confidence less than 0', () => {
      const result = LlmResponseSchema.safeParse({
        verdict: 'confirmed',
        confidence: -0.1,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const confidenceIssue = result.error.issues.find(
          (i) => i.path.includes('confidence')
        );
        expect(confidenceIssue).toBeDefined();
        expect(confidenceIssue!.code).toBe('too_small');
      }
    });

    it('rejects non-numeric confidence', () => {
      const result = LlmResponseSchema.safeParse({
        verdict: 'confirmed',
        confidence: 'high',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('verdict field accepts any string (validated downstream)', () => {
    // The schema accepts any string for verdict — downstream code validates
    // against VALID_SOURCE_CHECK_VERDICTS. This is intentional: the schema
    // should parse without throwing, and callLlmForSourcing maps unknown
    // verdicts to 'unverifiable'.
    it('accepts known verdict strings', () => {
      for (const v of ['confirmed', 'contradicted', 'unverifiable', 'outdated', 'partial']) {
        expect(LlmResponseSchema.parse({ verdict: v }).verdict).toBe(v);
      }
    });

    it('accepts unknown verdict strings (validation happens downstream)', () => {
      // The schema itself is permissive — it's a z.string(), not z.enum()
      const result = LlmResponseSchema.parse({ verdict: 'maybe_true' });
      expect(result.verdict).toBe('maybe_true');
    });
  });
});

// ── validateVerdict ─────────────────────────────────────────────────

describe('validateVerdict', () => {
  it('returns each valid verdict unchanged', () => {
    const validVerdicts = ['confirmed', 'contradicted', 'unverifiable', 'outdated', 'partial'] as const;
    for (const v of validVerdicts) {
      expect(validateVerdict(v)).toBe(v);
    }
  });

  it('maps empty string to unverifiable', () => {
    expect(validateVerdict('')).toBe('unverifiable');
  });

  it('maps random/garbage strings to unverifiable', () => {
    expect(validateVerdict('maybe')).toBe('unverifiable');
    expect(validateVerdict('CONFIRMED')).toBe('unverifiable');
    expect(validateVerdict('true')).toBe('unverifiable');
    expect(validateVerdict('yes')).toBe('unverifiable');
    expect(validateVerdict('Contradicted')).toBe('unverifiable');
    expect(validateVerdict('partially confirmed')).toBe('unverifiable');
  });

  it('is case-sensitive (uppercase variants are rejected)', () => {
    expect(validateVerdict('OUTDATED')).toBe('unverifiable');
    expect(validateVerdict('Partial')).toBe('unverifiable');
  });

  it('does not trim whitespace', () => {
    expect(validateVerdict(' confirmed')).toBe('unverifiable');
    expect(validateVerdict('confirmed ')).toBe('unverifiable');
    expect(validateVerdict(' confirmed ')).toBe('unverifiable');
  });
});

// ── Schema + validateVerdict integration ────────────────────────────

describe('LlmResponseSchema + validateVerdict integration', () => {
  it('schema parses then validateVerdict filters unknown verdicts', () => {
    // Simulates the flow in callLlmForSourcing: parse with Zod, then validate verdict
    const raw = {
      verdict: 'maybe_correct',
      confidence: 0.7,
      extracted_value: '42',
      reasoning: 'Seems right',
    };
    const parsed = LlmResponseSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const verdict = validateVerdict(parsed.data.verdict);
      expect(verdict).toBe('unverifiable');
    }
  });

  it('end-to-end with valid verdict', () => {
    const raw = {
      verdict: 'contradicted',
      confidence: 0.85,
      extracted_value: '$1.2 billion',
      reasoning: 'Source says $1.2B, not $2.5B',
    };
    const parsed = LlmResponseSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const verdict = validateVerdict(parsed.data.verdict);
      expect(verdict).toBe('contradicted');
      expect(parsed.data.confidence).toBe(0.85);
      expect(parsed.data.extracted_value).toBe('$1.2 billion');
    }
  });

  it('end-to-end with all defaults', () => {
    const parsed = LlmResponseSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const verdict = validateVerdict(parsed.data.verdict);
      expect(verdict).toBe('unverifiable');
      expect(parsed.data.confidence).toBe(0.5);
      expect(parsed.data.extracted_value).toBe('');
      expect(parsed.data.reasoning).toBe('');
    }
  });

  it('end-to-end with out-of-range confidence fails at parse', () => {
    const parsed = LlmResponseSchema.safeParse({
      verdict: 'confirmed',
      confidence: 2.0,
    });
    expect(parsed.success).toBe(false);
  });
});
