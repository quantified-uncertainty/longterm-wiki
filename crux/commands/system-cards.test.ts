import { describe, it, expect } from 'vitest';
import { toSyncItem } from './system-cards.ts';
import type { ExtractResult, ExtractedCard } from '../system-cards/extract-system-card.ts';
import type { VerifyResult } from '../system-cards/span-verify.ts';

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

function mkExtract(overrides: Partial<ExtractResult> = {}): ExtractResult {
  return {
    card: EMPTY_CARD,
    sourceText: 'fixture source text',
    lab: 'anthropic',
    sourceFormat: 'pdf',
    sourceHash: 'deadbeef0000000000000000000000000000000000000000000000000000cafe',
    waybackSnapshotUrl: null,
    usage: { input_tokens: 100, output_tokens: 50 },
    extractorVersion: 'system-card-extractor@1.0',
    extractionModel: 'claude-sonnet-4-6',
    extractedAt: '2026-04-24T00:00:00.000Z',
    ...overrides,
  };
}

function mkVerify(verifiedCard: ExtractedCard = EMPTY_CARD): VerifyResult {
  return {
    verifiedCard,
    verdicts: {},
    droppedFields: [],
    ungroundedFields: [],
    confidenceMap: { context_window_tokens: 1.0 },
  };
}

describe('toSyncItem', () => {
  it('generates a 10-char alphanumeric id deterministic on sourceHash + aiModelId', () => {
    const extract = mkExtract();
    const verify = mkVerify();
    const a = toSyncItem(extract, verify, {
      aiModelId: 'sid_XXXXXXXXXX',
      sourceUrl: 'https://example.com/card.pdf',
    });
    const b = toSyncItem(extract, verify, {
      aiModelId: 'sid_XXXXXXXXXX',
      sourceUrl: 'https://example.com/card.pdf',
    });
    expect(typeof a.id).toBe('string');
    expect((a.id as string).length).toBe(10);
    expect(/^[A-Za-z0-9_-]{10}$/.test(a.id as string)).toBe(true);
    // Same inputs → same id (deterministic).
    expect(a.id).toBe(b.id);

    const c = toSyncItem(extract, verify, {
      aiModelId: 'sid_YYYYYYYYYY',
      sourceUrl: 'https://example.com/card.pdf',
    });
    expect(c.id).not.toBe(a.id);
  });

  it('passes through camelCased sync-ready fields', () => {
    const verifiedCard: ExtractedCard = {
      ...EMPTY_CARD,
      version: '4.5',
      release_date: '2026-03-15',
      context_window_tokens: 200_000,
      safety_framework: 'ASL',
      safety_tier: 'ASL-3',
      safety_tier_domains: { bio: 'High', cyber: 'Medium' },
      modalities_in: ['text', 'image'],
    };
    const item = toSyncItem(mkExtract(), mkVerify(verifiedCard), {
      aiModelId: 'sid_XXXXXXXXXX',
      sourceUrl: 'https://example.com/card.pdf',
    });
    expect(item.version).toBe('4.5');
    expect(item.releaseDate).toBe('2026-03-15');
    expect(item.contextWindowTokens).toBe(200_000);
    expect(item.safetyFramework).toBe('ASL');
    expect(item.safetyTier).toBe('ASL-3');
    expect(item.safetyTierDomains).toEqual({ bio: 'High', cyber: 'Medium' });
    expect(item.modalitiesIn).toEqual(['text', 'image']);
  });

  it('maps eval_scores_cited with 0 sentinel for unknown scores', () => {
    const verifiedCard: ExtractedCard = {
      ...EMPTY_CARD,
      eval_scores_cited: [
        { benchmark: 'MMLU-Pro', score: 86.0, metric: 'CoT', setup: '5-shot', excerpt: 'text' },
        { benchmark: 'HumanEval', score: null, excerpt: 'score reported but unparseable' },
      ],
    };
    const item = toSyncItem(mkExtract(), mkVerify(verifiedCard), {
      aiModelId: 'sid_XXXXXXXXXX',
      sourceUrl: 'https://example.com/card.pdf',
    });
    const scores = item.evalScoresCited as Array<{ benchmark: string; score: number }>;
    expect(scores).toHaveLength(2);
    expect(scores[0].score).toBe(86.0);
    expect(scores[1].score).toBe(0); // null → 0 sentinel
  });

  it('includes extractor metadata and confidence map', () => {
    const item = toSyncItem(mkExtract(), mkVerify(), {
      aiModelId: 'sid_XXXXXXXXXX',
      sourceUrl: 'https://example.com/card.pdf',
    });
    expect(item.extractorVersion).toBe('system-card-extractor@1.0');
    expect(item.extractionModel).toBe('claude-sonnet-4-6');
    expect(item.extractedAt).toBe('2026-04-24T00:00:00.000Z');
    expect(item.sourceHash).toBe(
      'deadbeef0000000000000000000000000000000000000000000000000000cafe',
    );
    expect(item.sourceFormat).toBe('pdf');
    expect(item.sourceUrl).toBe('https://example.com/card.pdf');
    expect(item.extractionConfidence).toEqual({ context_window_tokens: 1.0 });
  });

  it('preserves aiModelDisplayName when provided', () => {
    const item = toSyncItem(mkExtract(), mkVerify(), {
      aiModelId: 'sid_XXXXXXXXXX',
      aiModelDisplayName: 'Claude 4.5 Sonnet',
      sourceUrl: 'https://example.com/card.pdf',
    });
    expect(item.aiModelDisplayName).toBe('Claude 4.5 Sonnet');
  });
});
