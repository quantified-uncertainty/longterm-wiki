import { describe, it, expect } from 'vitest';
import { verifyExcerpt, verifyExtractedCard } from './span-verify.ts';
import type { ExtractedCard } from './extract-system-card.ts';

const EMPTY_CARD: ExtractedCard = {
  version: null,
  release_date: null,
  deprecation_date: null,
  training_cutoff: null,
  training_compute_flops: null,
  training_gpu_hours: null,
  training_hardware: null,
  parameters_total: null,
  parameters_active: null,
  architecture: null,
  modalities_in: null,
  modalities_out: null,
  context_window_tokens: null,
  output_window_tokens: null,
  languages_supported: null,
  safety_framework: null,
  safety_tier: null,
  safety_tier_domains: null,
  safeguards_summary: null,
  classifier_details: null,
  fine_tuning_policy: null,
  deployment_channels: null,
  eval_scores_cited: null,
  third_party_evals: null,
  red_team_summary: null,
  incident_disclosures: null,
  system_prompt_url: null,
  usage_policy_url: null,
  notes: null,
  excerpts: {},
};

describe('verifyExcerpt', () => {
  const source = `The Claude 4 model is classified as ASL-3 under the
Responsible Scaling Policy. Context window is 200,000 tokens and the
training cutoff is December 2024.`;

  it('returns verified=true (confidence 1) for exact substring', () => {
    // Single-line excerpt that appears verbatim on one line.
    const v = verifyExcerpt('The Claude 4 model is classified as ASL-3', source);
    expect(v.verified).toBe(true);
    expect(v.confidence).toBe(1);
  });

  it('returns verified=true (confidence 0.9) when only whitespace differs', () => {
    // Crosses a \n in the source — exact fails, whitespace-normalized wins.
    const v = verifyExcerpt(
      'classified as ASL-3 under the Responsible Scaling Policy',
      source,
    );
    expect(v.verified).toBe(true);
    expect(v.confidence).toBe(0.9);
  });

  it('returns verified=true on Jaccard fuzzy match with a low threshold', () => {
    // Tokens mostly overlap but order differs; at the default threshold (0.7)
    // this would fail. We verify the Jaccard path with an explicitly low
    // threshold so the test doesn't depend on exact tokenization constants.
    const v = verifyExcerpt(
      'Claude classified ASL Responsible Scaling Policy under',
      source,
      { jaccardThreshold: 0.2 },
    );
    expect(v.verified).toBe(true);
    expect(v.confidence).toBeGreaterThan(0.2);
    expect(v.confidence).toBeLessThan(1); // Not an exact or whitespace match.
  });

  it('returns verified=false for hallucinated content', () => {
    const v = verifyExcerpt(
      'safety tier is ASL-4 and training compute was 10^26 FLOPs',
      source,
    );
    expect(v.verified).toBe(false);
    expect(v.reason).toBe('not-found');
  });

  it('returns verified=false when excerpt is missing', () => {
    const v = verifyExcerpt('', source);
    expect(v.verified).toBe(false);
    expect(v.reason).toBe('no-excerpt');
  });

  it('returns verified=false for excerpts too short to verify', () => {
    const v = verifyExcerpt('hi', source);
    expect(v.verified).toBe(false);
    expect(v.reason).toBe('excerpt-too-short');
  });

  it('accepts a custom Jaccard threshold', () => {
    const v1 = verifyExcerpt(
      'completely unrelated words about something else entirely',
      source,
      { jaccardThreshold: 0.01 },
    );
    // Even with a low threshold, no overlap → still fails.
    expect(v1.verified).toBe(false);
  });
});

describe('verifyExtractedCard', () => {
  const source =
    'Claude 4 — ASL-3 under the Responsible Scaling Policy. Context window: 200,000 tokens.';

  it('keeps fields whose excerpts are verified', () => {
    const card: ExtractedCard = {
      ...EMPTY_CARD,
      safety_tier: 'ASL-3',
      context_window_tokens: 200_000,
      excerpts: {
        safety_tier: 'ASL-3 under the Responsible Scaling Policy',
        context_window_tokens: 'Context window: 200,000 tokens',
      },
    };
    const result = verifyExtractedCard(card, source);
    expect(result.verifiedCard.safety_tier).toBe('ASL-3');
    expect(result.verifiedCard.context_window_tokens).toBe(200_000);
    expect(result.droppedFields).toEqual([]);
  });

  it('drops fields whose excerpts are hallucinated', () => {
    const card: ExtractedCard = {
      ...EMPTY_CARD,
      safety_tier: 'ASL-5',
      parameters_total: 999_000_000_000,
      excerpts: {
        safety_tier: 'classified as ASL-5 under an updated policy', // not in source
        parameters_total: 'parameters total 999 billion', // not in source
      },
    };
    const result = verifyExtractedCard(card, source);
    expect(result.verifiedCard.safety_tier).toBeNull();
    expect(result.verifiedCard.parameters_total).toBeNull();
    expect(result.droppedFields).toContain('safety_tier');
    expect(result.droppedFields).toContain('parameters_total');
  });

  it('flags fields with no excerpt as ungrounded', () => {
    const card: ExtractedCard = {
      ...EMPTY_CARD,
      training_compute_flops: 1e25,
      excerpts: { training_compute_flops: '' },
    };
    const result = verifyExtractedCard(card, source);
    expect(result.verifiedCard.training_compute_flops).toBeNull();
    expect(result.ungroundedFields).toContain('training_compute_flops');
    expect(result.confidenceMap.training_compute_flops).toBe(0);
  });

  it('walks eval_scores_cited row-by-row and drops unverified rows', () => {
    const sourceWithEvals =
      'MMLU-Pro: 86.0% (5-shot CoT). The model performs well on reasoning.';
    const card: ExtractedCard = {
      ...EMPTY_CARD,
      eval_scores_cited: [
        { benchmark: 'MMLU-Pro', score: 86.0, metric: 'CoT', setup: '5-shot', excerpt: 'MMLU-Pro: 86.0% (5-shot CoT)' },
        { benchmark: 'HumanEval', score: 99.9, excerpt: 'HumanEval score was 99.9% in zero-shot' },
      ],
      excerpts: {},
    };
    const result = verifyExtractedCard(card, sourceWithEvals);
    expect(result.verifiedCard.eval_scores_cited).toHaveLength(1);
    expect(result.verifiedCard.eval_scores_cited?.[0].benchmark).toBe('MMLU-Pro');
    expect(result.droppedFields.some((k) => k.includes('HumanEval'))).toBe(true);
  });

  it('skips metadata fields (notes, safety_framework) without requiring excerpts', () => {
    const card: ExtractedCard = {
      ...EMPTY_CARD,
      notes: 'This is agent commentary.',
      safety_framework: 'ASL',
      excerpts: {},
    };
    const result = verifyExtractedCard(card, source);
    expect(result.verifiedCard.notes).toBe('This is agent commentary.');
    expect(result.verifiedCard.safety_framework).toBe('ASL');
    expect(result.droppedFields).toEqual([]);
  });
});
