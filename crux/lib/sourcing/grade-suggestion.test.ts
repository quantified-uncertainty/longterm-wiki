/**
 * Tests for grade-suggestion.ts (QUA-592).
 *
 * Covers the four contract guarantees:
 *   1. Threshold semantics (the integration test in sourcing-suggest-urls
 *      handles >= comparison; this test just confirms the grader returns
 *      the parsed confidence number unchanged).
 *   2. JSON parse failure -> ok=false (fail-closed).
 *   3. Schema validation failure -> ok=false (fail-closed).
 *   4. Missing API key -> ok=false (fail-closed, no client constructed).
 *   5. XML escaping in the prompt for adversarial entity / claim / snippet
 *      content.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCallLlm = vi.fn();
vi.mock('../llm.ts', async () => {
  const actual = await vi.importActual<typeof import('../llm.ts')>('../llm.ts');
  return {
    ...actual,
    callLlm: (...args: unknown[]) => mockCallLlm(...args),
  };
});

const mockGetApiKey = vi.fn();
vi.mock('../api-keys.ts', async () => {
  const actual = await vi.importActual<typeof import('../api-keys.ts')>('../api-keys.ts');
  return {
    ...actual,
    getApiKey: (...args: unknown[]) => mockGetApiKey(...args),
  };
});

import type Anthropic from '@anthropic-ai/sdk';
import {
  gradeSuggestion,
  buildGraderPrompt,
  type GraderInput,
} from './grade-suggestion.ts';

const baseInput: GraderInput = {
  entityName: 'Anthropic',
  claimText: 'Anthropic had 500 employees in 2024',
  fieldName: 'employee_count',
  candidate: {
    url: 'https://example.com/anthropic',
    title: 'Anthropic 500 employees',
    snippet: 'Anthropic grew to 500 employees in 2024.',
  },
};

// A non-null injected client bypasses the missing-key fail-closed branch in
// gradeSuggestion. Stub identity is irrelevant because callLlm is mocked.
const fakeClient = {} as unknown as Anthropic;

describe('buildGraderPrompt', () => {
  it('escapes XML metacharacters in entity, claim, title, and snippet', () => {
    const prompt = buildGraderPrompt({
      entityName: '<script>',
      claimText: 'A & B & C',
      fieldName: 'x>y',
      candidate: {
        url: 'https://example.com/?a=1&b=2',
        title: '<title>',
        snippet: 'a < b > c & d',
      },
    });
    // Raw '<' / '&' from user input should never appear with their original
    // semantic meaning in the prompt; they're only allowed inside the
    // grader's own structural tags.
    expect(prompt).not.toContain('<script>');
    expect(prompt).toContain('&lt;script&gt;');
    expect(prompt).toContain('A &amp; B &amp; C');
    expect(prompt).toContain('x&gt;y');
    expect(prompt).toContain('&lt;title&gt;');
    expect(prompt).toContain('a &lt; b &gt; c &amp; d');
    // The structural <entity>, <claim>, <candidate> tags must remain
    // unescaped — they're how the model parses the input.
    expect(prompt).toContain('<entity>');
    expect(prompt).toContain('<claim>');
    expect(prompt).toContain('<candidate>');
  });

  it('omits the <field> line when fieldName is null/empty', () => {
    const noField = buildGraderPrompt({
      ...baseInput,
      fieldName: null,
    });
    expect(noField).not.toContain('<field>');

    const emptyField = buildGraderPrompt({
      ...baseInput,
      fieldName: '',
    });
    expect(emptyField).not.toContain('<field>');
  });

  it('handles a null snippet without crashing or printing "null"', () => {
    const prompt = buildGraderPrompt({
      ...baseInput,
      candidate: { ...baseInput.candidate, snippet: null },
    });
    expect(prompt).toContain('<snippet></snippet>');
    expect(prompt).not.toContain('null</snippet>');
  });
});

describe('gradeSuggestion', () => {
  beforeEach(() => {
    mockCallLlm.mockReset();
    mockGetApiKey.mockReset();
    mockGetApiKey.mockReturnValue('sk-test-key');
  });

  it('returns ok:true with parsed confidence on a valid response', async () => {
    mockCallLlm.mockResolvedValue({
      text: JSON.stringify({ confidence: 0.85, reasoning: 'title mentions exact claim' }),
      usage: { input_tokens: 200, output_tokens: 50 },
    });
    const out = await gradeSuggestion(baseInput, { client: fakeClient });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.confidence).toBe(0.85);
      expect(out.reasoning).toBe('title mentions exact claim');
      // Haiku at $0.80/M in + $4.00/M out:
      //   200/1e6 * 0.80 + 50/1e6 * 4.00 = 0.00016 + 0.0002 = 0.00036
      expect(out.costUsd).toBeCloseTo(0.00036, 7);
    }
  });

  it('preserves boundary confidences (0 and 1) without clamping or rounding', async () => {
    mockCallLlm.mockResolvedValueOnce({
      text: JSON.stringify({ confidence: 0, reasoning: 'unrelated' }),
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    const lo = await gradeSuggestion(baseInput, { client: fakeClient });
    expect(lo.ok).toBe(true);
    if (lo.ok) expect(lo.confidence).toBe(0);

    mockCallLlm.mockResolvedValueOnce({
      text: JSON.stringify({ confidence: 1, reasoning: 'exact' }),
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    const hi = await gradeSuggestion(baseInput, { client: fakeClient });
    expect(hi.ok).toBe(true);
    if (hi.ok) expect(hi.confidence).toBe(1);
  });

  it('fails closed when the response is not valid JSON, but still reports the cost the LLM charged', async () => {
    // Token-cost rationale: the LLM was actually called and we paid for it.
    // Reporting costUsd=0 here would let a sweep grade thousands of times
    // with garbage responses while showing zero spend in the summary.
    mockCallLlm.mockResolvedValue({
      text: 'not json at all just prose',
      usage: { input_tokens: 100, output_tokens: 30 },
    });
    const out = await gradeSuggestion(baseInput, { client: fakeClient });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toMatch(/JSON parse/i);
      expect(out.costUsd).toBeGreaterThan(0);
    }
  });

  it('fails closed when JSON parses but confidence is out of range', async () => {
    mockCallLlm.mockResolvedValue({
      text: JSON.stringify({ confidence: 1.5, reasoning: 'too high' }),
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    const out = await gradeSuggestion(baseInput, { client: fakeClient });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toMatch(/Schema validation/i);
      // Schema failure happens after the API call — cost should be real, not 0.
      expect(out.costUsd).toBeGreaterThan(0);
    }
  });

  it('fails closed when JSON parses but confidence is missing entirely', async () => {
    mockCallLlm.mockResolvedValue({
      text: JSON.stringify({ reasoning: 'forgot confidence' }),
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    const out = await gradeSuggestion(baseInput, { client: fakeClient });
    expect(out.ok).toBe(false);
  });

  it('fails closed when the LLM call itself throws and reports zero cost', async () => {
    // A pre-API failure (e.g., DNS error before a single token was streamed)
    // legitimately costs nothing — distinct from the parse/schema failures
    // above where the API actually charged us.
    mockCallLlm.mockRejectedValue(new Error('network blew up'));
    const out = await gradeSuggestion(baseInput, { client: fakeClient });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toMatch(/LLM call failed.*network blew up/i);
      expect(out.costUsd).toBe(0);
    }
  });

  it('fails closed when ANTHROPIC_BILLING_KEY is missing AND no client is injected', async () => {
    mockGetApiKey.mockReturnValue(undefined);
    const out = await gradeSuggestion(baseInput);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/ANTHROPIC_BILLING_KEY not set/);
    // The grader must NOT have called the LLM if the key was missing.
    expect(mockCallLlm).not.toHaveBeenCalled();
  });

  it('does NOT short-circuit when an explicit client is injected even if no key is set', async () => {
    // Tests can inject a client without setting an env var.
    mockGetApiKey.mockReturnValue(undefined);
    mockCallLlm.mockResolvedValue({
      text: JSON.stringify({ confidence: 0.5, reasoning: 'mid' }),
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    const out = await gradeSuggestion(baseInput, { client: fakeClient });
    expect(out.ok).toBe(true);
    expect(mockCallLlm).toHaveBeenCalledTimes(1);
  });
});
