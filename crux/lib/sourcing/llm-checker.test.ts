/**
 * Tests for llm-checker.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock callLlm BEFORE importing the module under test so the import binding
// resolves to the mock. Also stub `getApiKey` to avoid env dependency.
const mockCallLlm = vi.fn();
vi.mock('../llm.ts', async () => {
  const actual = await vi.importActual<typeof import('../llm.ts')>('../llm.ts');
  return {
    ...actual,
    callLlm: (...args: unknown[]) => mockCallLlm(...args),
  };
});

import { callLlmForSourcing, validateVerdict } from './llm-checker.ts';

describe('validateVerdict', () => {
  it('returns valid verdicts unchanged', () => {
    expect(validateVerdict('confirmed')).toBe('confirmed');
    expect(validateVerdict('contradicted')).toBe('contradicted');
    expect(validateVerdict('unverifiable')).toBe('unverifiable');
    expect(validateVerdict('outdated')).toBe('outdated');
    expect(validateVerdict('partial')).toBe('partial');
  });

  it('returns "unverifiable" for invalid verdicts', () => {
    expect(validateVerdict('unknown')).toBe('unverifiable');
    expect(validateVerdict('')).toBe('unverifiable');
    expect(validateVerdict('CONFIRMED')).toBe('unverifiable'); // case-sensitive
    expect(validateVerdict('true')).toBe('unverifiable');
    expect(validateVerdict('yes')).toBe('unverifiable');
  });

  it('returns "unverifiable" for empty/whitespace strings', () => {
    expect(validateVerdict('')).toBe('unverifiable');
    expect(validateVerdict(' ')).toBe('unverifiable');
  });
});

// QUA-648: subject-identity downgrade.
// The LLM is instructed to return `subject_matches_claim: false` when the
// source is about a materially different entity (e.g., Microsoft AI when the
// claim is about Microsoft Corp). If the LLM also returns `confirmed`, the
// checker downgrades to `partial` and annotates the reasoning.
describe('callLlmForSourcing — subject-identity downgrade (QUA-648)', () => {
  const fakeClient = {} as Parameters<typeof callLlmForSourcing>[0];

  beforeEach(() => {
    mockCallLlm.mockReset();
  });

  function llmReturns(body: Record<string, unknown>) {
    mockCallLlm.mockResolvedValue({ text: JSON.stringify(body) });
  }

  it('downgrades confirmed → partial when subject_matches_claim is false', async () => {
    llmReturns({
      verdict: 'confirmed',
      confidence: 0.95,
      extracted_value: 'CEO of Microsoft AI is Mustafa Süleyman',
      reasoning: 'Source confirms the CEO value.',
      source_subject: 'Microsoft AI',
      subject_matches_claim: false,
    });

    const result = await callLlmForSourcing(fakeClient, 'prompt', 'label');

    expect(result.verdict).toBe('partial');
    expect(result.sourceSubject).toBe('Microsoft AI');
    expect(result.subjectMatchesClaim).toBe(false);
    expect(result.reasoning).toContain('[subject-mismatch');
    expect(result.reasoning).toContain('Microsoft AI');
    expect(result.reasoning).toContain('Source confirms the CEO value.');
  });

  it('preserves confirmed when subject_matches_claim is true', async () => {
    llmReturns({
      verdict: 'confirmed',
      confidence: 0.95,
      extracted_value: 'CEO: Sam Altman',
      reasoning: 'Matches.',
      source_subject: 'OpenAI',
      subject_matches_claim: true,
    });

    const result = await callLlmForSourcing(fakeClient, 'prompt', 'label');

    expect(result.verdict).toBe('confirmed');
    expect(result.subjectMatchesClaim).toBe(true);
    expect(result.reasoning).not.toContain('[subject-mismatch');
  });

  it('preserves confirmed when subject_matches_claim is absent (backward compat)', async () => {
    llmReturns({
      verdict: 'confirmed',
      confidence: 0.95,
      extracted_value: 'x',
      reasoning: 'Matches.',
      // subject_matches_claim omitted — older prompts don't request it
    });

    const result = await callLlmForSourcing(fakeClient, 'prompt', 'label');

    expect(result.verdict).toBe('confirmed');
    expect(result.subjectMatchesClaim).toBeUndefined();
    expect(result.reasoning).not.toContain('[subject-mismatch');
  });

  it('does NOT downgrade non-confirmed verdicts on subject mismatch', async () => {
    // `partial` should stay `partial` — the rule only forbids false-confirms.
    llmReturns({
      verdict: 'partial',
      confidence: 0.8,
      extracted_value: 'x',
      reasoning: 'Partial match.',
      source_subject: 'Microsoft AI',
      subject_matches_claim: false,
    });

    const result = await callLlmForSourcing(fakeClient, 'prompt', 'label');

    expect(result.verdict).toBe('partial');
    // Reasoning is not re-annotated — the downgrade fires only when we
    // actually rewrite the verdict.
    expect(result.reasoning).toBe('Partial match.');
  });

  it('does NOT downgrade unverifiable on subject mismatch', async () => {
    llmReturns({
      verdict: 'unverifiable',
      confidence: 0.5,
      extracted_value: '',
      reasoning: 'Cannot verify.',
      source_subject: 'Microsoft AI',
      subject_matches_claim: false,
    });

    const result = await callLlmForSourcing(fakeClient, 'prompt', 'label');

    expect(result.verdict).toBe('unverifiable');
  });

  it('annotates reasoning even when source_subject is empty', async () => {
    llmReturns({
      verdict: 'confirmed',
      confidence: 0.9,
      extracted_value: 'x',
      reasoning: 'Matches.',
      source_subject: '',
      subject_matches_claim: false,
    });

    const result = await callLlmForSourcing(fakeClient, 'prompt', 'label');

    expect(result.verdict).toBe('partial');
    expect(result.reasoning).toContain('[subject-mismatch');
    expect(result.reasoning).toContain('Matches.');
  });

  it('passes source_subject through when no downgrade is needed', async () => {
    llmReturns({
      verdict: 'partial',
      confidence: 0.7,
      extracted_value: 'x',
      reasoning: 'Partial.',
      source_subject: 'OpenAI',
      subject_matches_claim: true,
    });

    const result = await callLlmForSourcing(fakeClient, 'prompt', 'label');

    expect(result.verdict).toBe('partial');
    expect(result.sourceSubject).toBe('OpenAI');
    expect(result.subjectMatchesClaim).toBe(true);
  });
});
