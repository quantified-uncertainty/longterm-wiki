/**
 * Tests for the formatNumericForPrompt helper and the rounding false-positive
 * prevention in source-check prompt builders.
 *
 * QUA-240: Source-check false positives from formatValue() rounding.
 * The core issue: formatValue() rounds numbers for display (e.g., 1,234,000,000 → "$1.2B"),
 * but the LLM then sees "$1.2B" as the claim and a source saying "$1.234 billion" and flags
 * it as contradicted. The fix annotates raw numbers with human-readable equivalents.
 */

import { describe, it, expect } from 'vitest';
import {
  formatNumericForPrompt,
  buildFactSourcingPrompt,
  buildRecordSourcingPrompt,
} from './item-verifier.ts';
import type { FactItemData, RecordItemData } from './orchestrator-types.ts';
import type { Fact, Entity as FBEntity } from '../../../packages/factbase/src/types.ts';

// ── formatNumericForPrompt ─────────────────────────────────────────

describe('formatNumericForPrompt', () => {
  describe('billions', () => {
    it('annotates billions with human-readable equivalent', () => {
      const result = formatNumericForPrompt(1_234_000_000);
      expect(result).toBe('1,234,000,000 (i.e. ~1.23 billion)');
    });

    it('handles exact billions', () => {
      const result = formatNumericForPrompt(1_000_000_000);
      expect(result).toBe('1,000,000,000 (i.e. ~1 billion)');
    });

    it('handles multi-billion values', () => {
      const result = formatNumericForPrompt(19_000_000_000);
      expect(result).toBe('19,000,000,000 (i.e. ~19 billion)');
    });

    it('preserves decimal precision for billions', () => {
      const result = formatNumericForPrompt(2_500_000_000);
      expect(result).toBe('2,500,000,000 (i.e. ~2.5 billion)');
    });
  });

  describe('millions', () => {
    it('annotates millions with human-readable equivalent', () => {
      const result = formatNumericForPrompt(50_000_000);
      expect(result).toBe('50,000,000 (i.e. ~50 million)');
    });

    it('handles exact millions', () => {
      const result = formatNumericForPrompt(1_000_000);
      expect(result).toBe('1,000,000 (i.e. ~1 million)');
    });

    it('preserves decimal precision for millions', () => {
      const result = formatNumericForPrompt(115_576_357);
      expect(result).toBe('115,576,357 (i.e. ~115.58 million)');
    });
  });

  describe('trillions', () => {
    it('annotates trillions with human-readable equivalent', () => {
      const result = formatNumericForPrompt(1_500_000_000_000);
      expect(result).toBe('1,500,000,000,000 (i.e. ~1.5 trillion)');
    });
  });

  describe('small numbers (no annotation needed)', () => {
    it('returns formatted number without annotation for small values', () => {
      expect(formatNumericForPrompt(1500)).toBe('1,500');
    });

    it('returns plain number for very small values', () => {
      expect(formatNumericForPrompt(42)).toBe('42');
    });

    it('returns zero as-is', () => {
      expect(formatNumericForPrompt(0)).toBe('0');
    });
  });

  describe('negative values', () => {
    it('handles negative billions', () => {
      const result = formatNumericForPrompt(-5_000_000_000);
      expect(result).toBe('-5,000,000,000 (i.e. -~5 billion)');
    });

    it('handles negative millions', () => {
      const result = formatNumericForPrompt(-850_000_000);
      expect(result).toBe('-850,000,000 (i.e. -~850 million)');
    });
  });

  describe('trailing zero trimming', () => {
    it('trims trailing zeros from decimal annotations', () => {
      // 5,000,000,000 → 5.00 billion → trimmed to "5"
      const result = formatNumericForPrompt(5_000_000_000);
      expect(result).toContain('~5 billion');
      expect(result).not.toContain('5.00');
    });

    it('preserves meaningful decimals', () => {
      // 1,230,000,000 → 1.23 billion
      const result = formatNumericForPrompt(1_230_000_000);
      expect(result).toContain('~1.23 billion');
    });

    it('trims single trailing zero', () => {
      // 1,200,000,000 → 1.20 billion → trimmed to "1.2"
      const result = formatNumericForPrompt(1_200_000_000);
      expect(result).toContain('~1.2 billion');
      expect(result).not.toContain('1.20');
    });
  });
});

// ── buildFactSourcingPrompt — rounding false positive prevention ────

describe('buildFactSourcingPrompt — rounding annotation', () => {
  function makeFactData(overrides: Partial<FactItemData> = {}): FactItemData {
    return {
      kind: 'fact',
      entity: {
        id: 'test123456',
        type: 'organization',
        name: 'Anthropic',
        stableId: 'test123456',
      } as FBEntity,
      fact: {
        id: 'f_test',
        subjectId: 'test123456',
        propertyId: 'revenue',
        value: { type: 'number', value: 1_234_000_000 },
        source: 'https://example.com/report',
      } as Fact,
      propertyName: 'Annual Revenue',
      formattedValue: '$1.2B',
      rawValue: '1234000000',
      ...overrides,
    };
  }

  it('includes human-readable annotation for large numeric raw values', () => {
    const prompt = buildFactSourcingPrompt(makeFactData(), 'Source text here');
    // Should contain the annotated raw value, not just the bare number
    expect(prompt).toContain('1,234,000,000');
    expect(prompt).toContain('~1.23 billion');
  });

  it('includes both the formatted display and the exact stored value', () => {
    const prompt = buildFactSourcingPrompt(makeFactData(), 'Source text here');
    expect(prompt).toContain('$1.2B');
    expect(prompt).toContain('exact stored value:');
  });

  it('does not add raw suffix when rawValue matches formattedValue', () => {
    const data = makeFactData({
      formattedValue: '42',
      rawValue: '42',
    });
    const prompt = buildFactSourcingPrompt(data, 'Source text');
    // The claim line should NOT contain "exact stored value" when values match
    const claimLine = prompt.split('\n').find(l => l.startsWith('Claim:'));
    expect(claimLine).toBeDefined();
    expect(claimLine).not.toContain('exact stored value');
  });

  it('shows plain raw value for small numbers', () => {
    const data = makeFactData({
      formattedValue: '$1,500',
      rawValue: '1500',
    });
    const prompt = buildFactSourcingPrompt(data, 'Source text');
    // The claim line should contain the raw value without billion/million annotation
    const claimLine = prompt.split('\n').find(l => l.startsWith('Claim:'));
    expect(claimLine).toBeDefined();
    expect(claimLine).toContain('exact stored value: 1500');
    expect(claimLine).not.toContain('billion');
    expect(claimLine).not.toContain('million');
  });
});

// ── buildRecordSourcingPrompt — monetary field annotation ──────────

describe('buildRecordSourcingPrompt — monetary field annotation', () => {
  function makeRecordData(
    fields: Record<string, string | number | null>,
    overrides: Partial<RecordItemData> = {},
  ): RecordItemData {
    return {
      kind: 'record',
      recordType: 'grant',
      recordId: 'g_test',
      fields,
      ...overrides,
    };
  }

  it('annotates large amount fields with human-readable equivalents', () => {
    const data = makeRecordData({ amount: 1_234_000_000, grantee: 'MIRI' });
    const prompt = buildRecordSourcingPrompt(data, 'Grant to MIRI', 'Source text');
    expect(prompt).toContain('1,234,000,000');
    expect(prompt).toContain('~1.23 billion');
  });

  it('annotates raised field in funding rounds', () => {
    const data = makeRecordData(
      { raised: 500_000_000, name: 'Series B' },
      { recordType: 'funding-round' },
    );
    const prompt = buildRecordSourcingPrompt(data, 'Funding round', 'Source text');
    expect(prompt).toContain('500,000,000');
    expect(prompt).toContain('~500 million');
  });

  it('annotates valuation field', () => {
    const data = makeRecordData(
      { valuation: 18_000_000_000 },
      { recordType: 'funding-round' },
    );
    const prompt = buildRecordSourcingPrompt(data, 'Funding round', 'Source text');
    expect(prompt).toContain('18,000,000,000');
    expect(prompt).toContain('~18 billion');
  });

  it('does not annotate non-monetary fields', () => {
    const data = makeRecordData({ name: 'Test Grant', grantee: 'MIT' });
    const prompt = buildRecordSourcingPrompt(data, 'Grant to MIT', 'Source text');
    // String fields should appear as-is in the Key fields section
    const fieldsSection = prompt.split('Key fields:\n')[1]?.split('\n\nSource text')[0] ?? '';
    expect(fieldsSection).toContain('name: Test Grant');
    expect(fieldsSection).toContain('grantee: MIT');
    // The fields section itself should not have "i.e." annotations for non-monetary fields
    expect(fieldsSection).not.toContain('i.e.');
  });

  it('does not annotate small monetary amounts', () => {
    const data = makeRecordData({ amount: 5000, grantee: 'Lab' });
    const prompt = buildRecordSourcingPrompt(data, 'Small grant', 'Source text');
    // Small monetary amounts should not get the "i.e." annotation in the fields section
    const fieldsSection = prompt.split('Key fields:\n')[1]?.split('\n\nSource text')[0] ?? '';
    expect(fieldsSection).toContain('amount: 5000');
    expect(fieldsSection).not.toContain('i.e.');
  });

  it('annotates impliedValuation field', () => {
    const data = makeRecordData(
      { impliedValuation: 61_000_000_000, company: 'Anthropic' },
      { recordType: 'secondary-market-price' },
    );
    const prompt = buildRecordSourcingPrompt(data, 'Market price', 'Source text');
    expect(prompt).toContain('61,000,000,000');
    expect(prompt).toContain('~61 billion');
  });
});

// ── buildRecordSourcingPrompt — scorecard_grade dispatch (QUA-978) ─────

describe('buildRecordSourcingPrompt — scorecard_grade excerpt dispatch', () => {
  function makeScorecardData(fields: Record<string, string | number | null>): RecordItemData {
    return {
      kind: 'record',
      recordType: 'scorecard_grade',
      recordId: 'fli_index-winter-2025|sid_test|test-dim',
      fields: { publisher: 'fli_index', entity: 'TestOrg', ...fields },
    };
  }

  it('uses domain-aware excerpt for per-dimension scorecard_grade rows', () => {
    // Source text long enough to exceed the prompt window with the
    // dimension's deep section past the first 30K chars.
    const header = 'MAIN_SCORECARD_TABLE '.padEnd(8_000, '.');
    const padding = 'noise '.repeat(7_000); // ~42K chars, total ~50K
    const deep = 'Existential Safety This domain examines preparedness';
    const sourceText = header + padding + deep;

    const data = makeScorecardData({
      dimension: 'Existential Safety',
      scoreLetter: 'D',
    });

    const prompt = buildRecordSourcingPrompt(data, 'Scorecard claim', sourceText);

    // Both header AND the dimension's deep section must be in the prompt.
    expect(prompt).toContain('MAIN_SCORECARD_TABLE');
    expect(prompt).toContain('Existential Safety This domain');
    expect(prompt).toContain('omitted');
  });

  it('uses default first-N-chars slice for non-scorecard record types', () => {
    // Build a 50K-char source where the same "deep section" exists past
    // the 30K window. For a non-scorecard record type the dispatch should
    // NOT route through the domain-aware extractor — the deep section
    // stays out of the excerpt.
    const header = 'EARLY_HEADER '.padEnd(8_000, '.');
    const padding = 'noise '.repeat(7_000);
    const deep = 'Existential Safety This domain examines';
    const sourceText = header + padding + deep;

    const data: RecordItemData = {
      kind: 'record',
      recordType: 'grant',
      recordId: 'g_test',
      fields: { dimension: 'Existential Safety' },
    };

    const prompt = buildRecordSourcingPrompt(data, 'Grant', sourceText);
    expect(prompt).toContain('EARLY_HEADER');
    expect(prompt).not.toContain('Existential Safety This domain');
    expect(prompt).not.toContain('omitted');
  });

  it('falls back to first-N slice for scorecard "Overall" rows', () => {
    const header = 'OVERALL_TABLE '.padEnd(8_000, '.');
    const padding = 'noise '.repeat(7_000);
    const deep = 'Existential Safety This domain examines';
    const sourceText = header + padding + deep;

    const data = makeScorecardData({
      dimension: 'Overall',
      scoreLetter: 'C+',
    });

    const prompt = buildRecordSourcingPrompt(data, 'Overall claim', sourceText);
    expect(prompt).toContain('OVERALL_TABLE');
    // No dispatch into the dimension extractor → no "omitted" separator.
    expect(prompt).not.toContain('omitted');
  });
});
