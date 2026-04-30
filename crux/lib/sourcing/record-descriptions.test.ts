import { describe, it, expect } from 'vitest';
import { buildRecordDescription, extractRecordFields } from './record-descriptions.ts';

describe('buildRecordDescription — scorecard_grade (QUA-864)', () => {
  it('produces a claim-shaped description with publisher / wave / entity / dimension / score', () => {
    const item = {
      id: 'fli-summer-2025__sid_anthropic__overall',
      entityId: 'sid_anthropic',
      entityTitle: 'Anthropic',
      entityDisplayName: 'Anthropic',
      scorecardSource: 'fli_index',
      publishedAt: '2025-06-15T00:00:00.000Z',
      dimensionSlug: 'overall',
      dimensionLabel: 'Overall',
      scoreLetter: 'C',
      scoreRaw: 'C',
      scoreNumeric: 60,
    };
    expect(buildRecordDescription('scorecard_grade', item)).toBe(
      'Scorecard: fli_index 2025-06-15 scored Anthropic on Overall = C',
    );
  });

  it('falls back to dimensionSlug when dimensionLabel is missing', () => {
    const item = {
      entityTitle: 'Meta',
      scorecardSource: 'saferai',
      dimensionSlug: 'risk-assessment',
      scoreLetter: 'D+',
    };
    expect(buildRecordDescription('scorecard_grade', item)).toContain('on risk-assessment');
  });

  it('uses scoreRaw when scoreLetter is null (fmti-style "Fulfilled" / "Partial")', () => {
    const item = {
      entityTitle: 'OpenAI',
      scorecardSource: 'fmti',
      dimensionLabel: 'Indicator 42: Risk mitigations',
      scoreLetter: null,
      scoreRaw: 'Partial',
      scoreNumeric: 50,
    };
    expect(buildRecordDescription('scorecard_grade', item)).toContain('= Partial');
  });

  it('uses scoreNumeric when both scoreLetter and scoreRaw are null', () => {
    const item = {
      entityTitle: 'OpenAI',
      scorecardSource: 'ailabwatch',
      dimensionLabel: 'Score',
      scoreLetter: null,
      scoreRaw: null,
      scoreNumeric: 47,
    };
    expect(buildRecordDescription('scorecard_grade', item)).toContain('= 47');
  });

  it('falls back to N/A when no score field is present', () => {
    const item = {
      entityTitle: 'Anthropic',
      scorecardSource: 'fli_index',
      dimensionLabel: 'Overall',
    };
    expect(buildRecordDescription('scorecard_grade', item)).toContain('= N/A');
  });

  it('omits the wave date when publishedAt is missing', () => {
    const item = {
      entityTitle: 'Anthropic',
      scorecardSource: 'fli_index',
      dimensionLabel: 'Overall',
      scoreLetter: 'C',
    };
    const desc = buildRecordDescription('scorecard_grade', item);
    expect(desc).toBe('Scorecard: fli_index scored Anthropic on Overall = C');
  });
});

describe('extractRecordFields — scorecard_grade (QUA-864)', () => {
  it('extracts publisher / publishedAt / entity / dimension / all three score forms', () => {
    const item = {
      id: 'fli-summer-2025__sid_anthropic__overall',
      entityId: 'sid_anthropic',
      entityTitle: 'Anthropic',
      entityDisplayName: 'Anthropic Inc',
      scorecardSource: 'fli_index',
      publishedAt: '2025-06-15T00:00:00.000Z',
      dimensionSlug: 'overall',
      dimensionLabel: 'Overall',
      scoreLetter: 'C',
      scoreRaw: 'C',
      scoreNumeric: 60,
    };
    const fields = extractRecordFields('scorecard_grade', item);
    expect(fields).toMatchObject({
      publisher: 'fli_index',
      publishedAt: '2025-06-15T00:00:00.000Z',
      entity: 'Anthropic',
      dimension: 'Overall',
      scoreLetter: 'C',
      scoreRaw: 'C',
      scoreNumeric: 60,
    });
  });

  it('returns null for missing optional score fields (no implicit zeroing)', () => {
    const item = {
      entityTitle: 'OpenAI',
      scorecardSource: 'fmti',
      dimensionSlug: 'indicator-1',
    };
    const fields = extractRecordFields('scorecard_grade', item);
    expect(fields.scoreLetter).toBeNull();
    expect(fields.scoreRaw).toBeNull();
    expect(fields.scoreNumeric).toBeNull();
  });

  it('falls back to dimensionSlug when dimensionLabel is missing', () => {
    const item = {
      entityTitle: 'Meta',
      scorecardSource: 'saferai',
      dimensionSlug: 'governance',
    };
    expect(extractRecordFields('scorecard_grade', item).dimension).toBe('governance');
  });
});
