import { describe, it, expect } from 'vitest';
import { normalizeExtractedCard, mapContentType } from './extract-system-card.ts';

describe('normalizeExtractedCard', () => {
  it('handles empty/missing input', () => {
    const c = normalizeExtractedCard(null);
    expect(c.version).toBeNull();
    expect(c.eval_scores_cited).toBeNull();
    expect(c.excerpts).toEqual({});
  });

  it('passes through valid scalar values', () => {
    const c = normalizeExtractedCard({
      version: '4.5',
      release_date: '2026-03-15',
      architecture: 'MoE',
      excerpts: { version: 'Claude 4.5' },
    });
    expect(c.version).toBe('4.5');
    expect(c.release_date).toBe('2026-03-15');
    expect(c.architecture).toBe('MoE');
    expect(c.excerpts.version).toBe('Claude 4.5');
  });

  it('coerces numeric strings to numbers', () => {
    const c = normalizeExtractedCard({
      context_window_tokens: '200000',
      parameters_total: '671000000000',
      training_gpu_hours: '1.5e7',
    });
    expect(c.context_window_tokens).toBe(200_000);
    expect(c.parameters_total).toBe(671_000_000_000);
    expect(c.training_gpu_hours).toBe(15_000_000);
  });

  it('strips commas from numeric strings', () => {
    const c = normalizeExtractedCard({
      context_window_tokens: '200,000',
      parameters_total: '671,000,000,000',
    });
    expect(c.context_window_tokens).toBe(200_000);
    expect(c.parameters_total).toBe(671_000_000_000);
  });

  it('returns null for non-numeric numeric fields', () => {
    const c = normalizeExtractedCard({
      context_window_tokens: 'undisclosed',
      parameters_total: null,
    });
    expect(c.context_window_tokens).toBeNull();
    expect(c.parameters_total).toBeNull();
  });

  it('normalizes modalities_in to a string array', () => {
    const c = normalizeExtractedCard({
      modalities_in: ['text', 'image', 42, ''],
    });
    // 42 and '' are filtered.
    expect(c.modalities_in).toEqual(['text', 'image']);
  });

  it('returns null for non-array modalities_in', () => {
    const c = normalizeExtractedCard({ modalities_in: 'text' });
    expect(c.modalities_in).toBeNull();
  });

  it('normalizes eval_scores_cited and filters rows missing benchmark', () => {
    const c = normalizeExtractedCard({
      eval_scores_cited: [
        { benchmark: 'MMLU', score: 86.0, metric: 'CoT' },
        { benchmark: '', score: 99 }, // filtered — empty benchmark
        { benchmark: 'HumanEval', score: '91.5', excerpt: 'HumanEval 91.5%' },
        'not an object',
      ],
    });
    expect(c.eval_scores_cited).toHaveLength(2);
    expect(c.eval_scores_cited?.[0].benchmark).toBe('MMLU');
    expect(c.eval_scores_cited?.[1].score).toBe(91.5);
  });

  it('handles object-valued fields (classifier_details, safety_tier_domains)', () => {
    const c = normalizeExtractedCard({
      classifier_details: { type: 'constitutional-classifier', coverage: 'CBRN' },
      safety_tier_domains: { bio: 'High', cyber: 'Medium' },
    });
    expect(c.classifier_details).toEqual({
      type: 'constitutional-classifier',
      coverage: 'CBRN',
    });
    expect(c.safety_tier_domains).toEqual({ bio: 'High', cyber: 'Medium' });
  });

  it('rejects non-object classifier_details', () => {
    const c = normalizeExtractedCard({
      classifier_details: 'just a string',
      safety_tier_domains: ['not', 'an', 'object'],
    });
    expect(c.classifier_details).toBeNull();
    expect(c.safety_tier_domains).toBeNull();
  });

  it('never crashes on wildly malformed input', () => {
    // Adversarial input — nothing should throw.
    const c = normalizeExtractedCard({
      version: { weirdly: 'nested' },
      release_date: 12345,
      eval_scores_cited: 'not an array',
      third_party_evals: null,
      modalities_in: null,
      excerpts: 'not an object',
    });
    expect(c.version).toBe('[object Object]'); // String() coercion
    expect(c.release_date).toBe('12345');
    expect(c.eval_scores_cited).toBeNull();
    expect(c.third_party_evals).toBeNull();
    expect(c.modalities_in).toBeNull();
    expect(c.excerpts).toEqual({});
  });
});

describe('mapContentType', () => {
  it('recognizes arxiv URLs', () => {
    expect(mapContentType('html', 'https://arxiv.org/abs/2401.01234')).toBe('arxiv-paper');
    expect(mapContentType('pdf', 'https://arxiv.org/pdf/2401.01234v1')).toBe('arxiv-paper');
    expect(mapContentType('html', 'https://ar5iv.labs.arxiv.org/html/2401.01234')).toBe(
      'arxiv-paper',
    );
  });

  it('recognizes PDFs', () => {
    expect(mapContentType('pdf', 'https://cdn.openai.com/gpt5-card.pdf')).toBe('pdf');
  });

  it('recognizes markdown URLs', () => {
    expect(
      mapContentType(
        'html',
        'https://github.com/meta-llama/llama-models/blob/main/models/llama3/MODEL_CARD.md',
      ),
    ).toBe('markdown');
    expect(mapContentType('html', 'https://example.com/card.markdown')).toBe('markdown');
  });

  it('defaults to html otherwise', () => {
    expect(mapContentType('html', 'https://www.anthropic.com/system-cards/claude-4')).toBe(
      'html',
    );
    expect(mapContentType('transcript', 'https://example.com')).toBe('html');
  });
});
