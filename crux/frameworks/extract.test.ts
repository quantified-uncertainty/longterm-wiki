import { describe, it, expect } from 'vitest';
import {
  normalizePass1Output,
  normalizeExtractedThreshold,
  locateSpan,
} from './extract.ts';

describe('normalizePass1Output', () => {
  it('returns empty candidate list on null', () => {
    expect(normalizePass1Output(null).candidates).toEqual([]);
  });

  it('returns empty candidate list on non-object', () => {
    expect(normalizePass1Output('garbage').candidates).toEqual([]);
    expect(normalizePass1Output(42).candidates).toEqual([]);
    expect(normalizePass1Output([]).candidates).toEqual([]);
  });

  it('drops candidates with missing or too-short anchor', () => {
    const out = normalizePass1Output({
      candidates: [
        { riskDomainCanonicalGuess: 'cbrn', riskDomainLabel: 'CBRN', tierLabelGuess: 'ASL-3', anchorQuote: null },
        { riskDomainCanonicalGuess: 'cbrn', riskDomainLabel: 'CBRN', tierLabelGuess: 'ASL-3', anchorQuote: 'tiny' },
        {
          riskDomainCanonicalGuess: 'cbrn',
          riskDomainLabel: 'CBRN',
          tierLabelGuess: 'ASL-3',
          anchorQuote: 'A properly long anchor quote that should pass the minimum threshold.',
        },
      ],
    });
    expect(out.candidates.length).toBe(1);
  });

  it('coerces unknown canonical guesses to "other"', () => {
    const out = normalizePass1Output({
      candidates: [
        {
          riskDomainCanonicalGuess: 'made-up-domain',
          riskDomainLabel: 'Some novel label',
          tierLabelGuess: 'T1',
          anchorQuote: 'An adequate anchor quote grounding this threshold.',
        },
      ],
    });
    expect(out.candidates[0].riskDomainCanonicalGuess).toBe('other');
  });

  it('recognizes alias guesses', () => {
    const out = normalizePass1Output({
      candidates: [
        {
          riskDomainCanonicalGuess: 'Offensive cyber',
          riskDomainLabel: 'Offensive cyber',
          tierLabelGuess: 'High',
          anchorQuote: 'A sufficient anchor for cyber threshold purposes.',
        },
      ],
    });
    expect(out.candidates[0].riskDomainCanonicalGuess).toBe('cyber');
  });

  it('preserves verbatim labels', () => {
    const out = normalizePass1Output({
      candidates: [
        {
          riskDomainCanonicalGuess: 'cbrn',
          riskDomainLabel: 'Biological and Chemical Uplift',
          tierLabelGuess: 'ASL-3',
          anchorQuote: 'Anchor quote long enough to be accepted.',
        },
      ],
    });
    expect(out.candidates[0].riskDomainLabel).toBe('Biological and Chemical Uplift');
  });
});

describe('normalizeExtractedThreshold', () => {
  const fallback = {
    riskDomainCanonical: 'cbrn' as const,
    riskDomainLabel: 'CBRN',
    tierLabel: 'ASL-3',
  };

  it('returns null when required fields are missing', () => {
    expect(normalizeExtractedThreshold(null, fallback)).toBeNull();
    expect(normalizeExtractedThreshold({}, fallback)).toBeNull();
    expect(
      normalizeExtractedThreshold({ triggerDescription: 'x' }, fallback),
    ).toBeNull();
    expect(
      normalizeExtractedThreshold({ sourceQuote: 'x' }, fallback),
    ).toBeNull();
  });

  it('coerces invalid tierSortOrder to 1', () => {
    const out = normalizeExtractedThreshold(
      {
        riskDomainCanonical: 'cbrn',
        riskDomainLabel: 'CBRN',
        tierLabel: 'ASL-3',
        tierSortOrder: 99,
        triggerDescription: 'test trigger',
        sourceQuote: 'test quote from the document',
      },
      fallback,
    );
    expect(out?.tierSortOrder).toBe(1);
  });

  it('clamps extractionConfidence to [0, 1]', () => {
    const hi = normalizeExtractedThreshold(
      {
        riskDomainCanonical: 'cbrn',
        riskDomainLabel: 'CBRN',
        tierLabel: 'ASL-3',
        tierSortOrder: 2,
        triggerDescription: 't',
        sourceQuote: 'q',
        extractionConfidence: 5,
      },
      fallback,
    );
    expect(hi?.extractionConfidence).toBe(1);

    const lo = normalizeExtractedThreshold(
      {
        riskDomainCanonical: 'cbrn',
        riskDomainLabel: 'CBRN',
        tierLabel: 'ASL-3',
        tierSortOrder: 2,
        triggerDescription: 't',
        sourceQuote: 'q',
        extractionConfidence: -0.5,
      },
      fallback,
    );
    expect(lo?.extractionConfidence).toBe(0);
  });

  it('defaults confidence to 0.5 when missing/invalid', () => {
    const out = normalizeExtractedThreshold(
      {
        riskDomainCanonical: 'cbrn',
        riskDomainLabel: 'CBRN',
        tierLabel: 'ASL-3',
        tierSortOrder: 1,
        triggerDescription: 't',
        sourceQuote: 'q',
      },
      fallback,
    );
    expect(out?.extractionConfidence).toBe(0.5);
  });

  it('rejects unknown commitmentLanguage', () => {
    const out = normalizeExtractedThreshold(
      {
        riskDomainCanonical: 'cbrn',
        riskDomainLabel: 'CBRN',
        tierLabel: 'ASL-3',
        tierSortOrder: 1,
        triggerDescription: 't',
        sourceQuote: 'q',
        commitmentLanguage: 'made-up-label',
      },
      fallback,
    );
    expect(out?.commitmentLanguage).toBeNull();
  });

  it('keeps valid commitmentLanguage', () => {
    const out = normalizeExtractedThreshold(
      {
        riskDomainCanonical: 'cbrn',
        riskDomainLabel: 'CBRN',
        tierLabel: 'ASL-3',
        tierSortOrder: 1,
        triggerDescription: 't',
        sourceQuote: 'q',
        commitmentLanguage: 'committed',
      },
      fallback,
    );
    expect(out?.commitmentLanguage).toBe('committed');
  });

  it('falls back to canonical when LLM returns unknown domain', () => {
    const out = normalizeExtractedThreshold(
      {
        riskDomainCanonical: 'unknown-domain',
        riskDomainLabel: 'Custom',
        tierLabel: 'T1',
        tierSortOrder: 1,
        triggerDescription: 't',
        sourceQuote: 'q',
      },
      { riskDomainCanonical: 'ai_rd', riskDomainLabel: 'AI R&D', tierLabel: 'T1' },
    );
    expect(out?.riskDomainCanonical).toBe('ai_rd');
  });
});

describe('locateSpan', () => {
  const doc = [
    'Intro paragraph.',
    'Section 1: Biological threshold.',
    'If a model can synthesize novel pathogens with 10x expert time reduction, it reaches ASL-3.',
    'Required mitigations include SL-3 security and restricted fine-tuning.',
    'Section 2: Cyber.',
    'If a model enables previously-impossible cyberattacks, it reaches ASL-4.',
  ].join('\n');

  it('returns a span around the anchor', () => {
    const span = locateSpan('synthesize novel pathogens', doc, 50);
    expect(span).toContain('synthesize novel pathogens');
    expect(span!.length).toBeGreaterThan(10);
  });

  it('matches case-insensitively', () => {
    const span = locateSpan('SYNTHESIZE NOVEL PATHOGENS', doc, 20);
    expect(span).not.toBeNull();
  });

  it('falls back to the first half of a long anchor', () => {
    const half = 'If a model can synthesize novel pathogens with 10x expert';
    // Use a slightly different tail that won't match full-text.
    const full = half + ' NOT MATCHING TAIL TEXT';
    const span = locateSpan(full, doc, 20);
    expect(span).not.toBeNull();
  });

  it('returns null when the anchor cannot be located', () => {
    expect(locateSpan('completely unrelated text', doc)).toBeNull();
  });

  it('handles empty inputs', () => {
    expect(locateSpan('', doc)).toBeNull();
    expect(locateSpan('something', '')).toBeNull();
  });
});
