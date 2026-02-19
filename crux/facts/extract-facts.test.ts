/**
 * Tests for fact extraction utilities.
 *
 * Tests the pure helper functions (content stripping, YAML generation, ID generation)
 * without requiring LLM API calls.
 */

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'crypto';

// ---------------------------------------------------------------------------
// Inline copies of the pure utility functions for testing
// (avoids re-running the full module with its side effects)
// ---------------------------------------------------------------------------

function generateFactId(): string {
  return randomBytes(4).toString('hex');
}

function stripAlreadyCoveredContent(content: string): string {
  let stripped = content.replace(/```[\s\S]*?```/g, '[CODE_BLOCK]');
  stripped = stripped.replace(/`[^`]+`/g, '[INLINE_CODE]');
  stripped = stripped.replace(/<F\s[^>]*\/>/g, '[FACT_REF]');
  stripped = stripped.replace(/<F(\s[^>]*)?>[\s\S]*?<\/F>/g, '[FACT_REF]');
  stripped = stripped.replace(/<Calc\s[^>]*\/>/g, '[CALC_REF]');
  stripped = stripped.replace(/<Calc(\s[^>]*)?>[\s\S]*?<\/Calc>/g, '[CALC_REF]');
  stripped = stripped.replace(/^import\s+.*$/gm, '');
  return stripped;
}

interface FactCandidateValue {
  min?: number;
  max?: number;
}

interface FactCandidate {
  id: string;
  entity: string;
  factId: string;
  label: string;
  value: number | string | number[] | FactCandidateValue;
  asOf: string;
  source?: string;
  measure?: string;
  note?: string;
  confidence: 'low' | 'medium' | 'high';
  reason: string;
  rawContext: string;
}

function generateYamlBlock(candidate: FactCandidate): string {
  const lines: string[] = [
    `  # ${candidate.factId}`,
    `  # AUTO-EXTRACTED — needs human review (confidence: ${candidate.confidence})`,
    `  ${candidate.id}:`,
  ];

  if (candidate.label) {
    lines.push(`    label: "${candidate.label}"`);
  }
  if (candidate.measure) {
    lines.push(`    measure: ${candidate.measure}`);
  }

  const val = candidate.value;
  if (Array.isArray(val)) {
    lines.push(`    value:`);
    for (const v of val) {
      lines.push(`      - ${v}`);
    }
  } else if (typeof val === 'object' && val !== null) {
    const range = val as FactCandidateValue;
    lines.push(`    value:`);
    if (range.min !== undefined) lines.push(`      min: ${range.min}`);
    if (range.max !== undefined) lines.push(`      max: ${range.max}`);
  } else if (typeof val === 'string') {
    lines.push(`    value: "${val}"`);
  } else {
    lines.push(`    value: ${val}`);
  }

  lines.push(`    asOf: "${candidate.asOf}"`);

  if (candidate.note) {
    const safeNote = candidate.note.replace(/"/g, "'");
    lines.push(`    note: "${safeNote}"`);
  }
  if (candidate.source) {
    lines.push(`    source: ${candidate.source}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateFactId', () => {
  it('returns an 8-character hex string', () => {
    const id = generateFactId();
    expect(id).toHaveLength(8);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('generates unique IDs across multiple calls', () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateFactId()));
    // With 20 random 32-bit values, collision is astronomically unlikely
    expect(ids.size).toBe(20);
  });
});

describe('stripAlreadyCoveredContent', () => {
  it('replaces fenced code blocks', () => {
    const input = 'Before\n```typescript\nconst x = 100;\n```\nAfter';
    const result = stripAlreadyCoveredContent(input);
    expect(result).toContain('[CODE_BLOCK]');
    expect(result).not.toContain('const x = 100');
    expect(result).toContain('Before');
    expect(result).toContain('After');
  });

  it('replaces inline code', () => {
    const input = 'Use `$100 billion` for this.';
    const result = stripAlreadyCoveredContent(input);
    expect(result).toContain('[INLINE_CODE]');
    expect(result).not.toContain('$100 billion');
  });

  it('replaces self-closing <F> tags', () => {
    const input = 'Revenue is <F id="openai.revenue-arr-2025" /> per year.';
    const result = stripAlreadyCoveredContent(input);
    expect(result).toContain('[FACT_REF]');
    expect(result).not.toContain('openai.revenue-arr-2025');
  });

  it('replaces paired <F>...</F> tags', () => {
    const input = 'Revenue is <F id="openai.revenue">$20B</F> per year.';
    const result = stripAlreadyCoveredContent(input);
    expect(result).toContain('[FACT_REF]');
    expect(result).not.toContain('$20B');
  });

  it('replaces <Calc> tags', () => {
    const input = 'Total: <Calc expr="{openai.revenue} * 2" />';
    const result = stripAlreadyCoveredContent(input);
    expect(result).toContain('[CALC_REF]');
    expect(result).not.toContain('openai.revenue');
  });

  it('removes import statements', () => {
    const input = `import EntityLink from '@components/EntityLink';\n\nContent here.`;
    const result = stripAlreadyCoveredContent(input);
    expect(result).not.toContain("import EntityLink");
    expect(result).toContain('Content here');
  });

  it('does not strip regular numbers in prose', () => {
    const input = 'OpenAI raised $10 billion in funding in 2024.';
    const result = stripAlreadyCoveredContent(input);
    expect(result).toContain('$10 billion');
    expect(result).toContain('2024');
  });
});

describe('generateYamlBlock', () => {
  const baseCandidate: FactCandidate = {
    id: 'a1b2c3d4',
    entity: 'openai',
    factId: 'valuation-2025',
    label: 'OpenAI valuation (2025)',
    value: 500000000000,
    asOf: '2025-10',
    measure: 'valuation',
    note: 'Secondary share sale valuation',
    confidence: 'high',
    reason: 'Commonly cited figure',
    rawContext: 'valued at $500 billion in a secondary share sale',
  };

  it('generates a well-formed YAML block', () => {
    const yaml = generateYamlBlock(baseCandidate);
    expect(yaml).toContain('# valuation-2025');
    expect(yaml).toContain('# AUTO-EXTRACTED — needs human review (confidence: high)');
    expect(yaml).toContain('a1b2c3d4:');
    expect(yaml).toContain('label: "OpenAI valuation (2025)"');
    expect(yaml).toContain('measure: valuation');
    expect(yaml).toContain('value: 500000000000');
    expect(yaml).toContain('asOf: "2025-10"');
    expect(yaml).toContain('note: "Secondary share sale valuation"');
  });

  it('formats array values as YAML list', () => {
    const candidate: FactCandidate = { ...baseCandidate, value: [200, 400] };
    const yaml = generateYamlBlock(candidate);
    expect(yaml).toContain('value:');
    expect(yaml).toContain('      - 200');
    expect(yaml).toContain('      - 400');
  });

  it('formats range objects with min/max', () => {
    const candidate: FactCandidate = { ...baseCandidate, value: { min: 100, max: 200 } };
    const yaml = generateYamlBlock(candidate);
    expect(yaml).toContain('value:');
    expect(yaml).toContain('      min: 100');
    expect(yaml).toContain('      max: 200');
  });

  it('formats lower-bound-only ranges', () => {
    const candidate: FactCandidate = { ...baseCandidate, value: { min: 500000000000 } };
    const yaml = generateYamlBlock(candidate);
    expect(yaml).toContain('      min: 500000000000');
    expect(yaml).not.toContain('max:');
  });

  it('quotes string values', () => {
    const candidate: FactCandidate = { ...baseCandidate, value: '1,700%' };
    const yaml = generateYamlBlock(candidate);
    expect(yaml).toContain('value: "1,700%"');
  });

  it('includes source when present', () => {
    const candidate: FactCandidate = {
      ...baseCandidate,
      source: 'https://example.com/source',
    };
    const yaml = generateYamlBlock(candidate);
    expect(yaml).toContain('source: https://example.com/source');
  });

  it('omits source when not present', () => {
    const candidate: FactCandidate = { ...baseCandidate, source: undefined };
    const yaml = generateYamlBlock(candidate);
    expect(yaml).not.toContain('source:');
  });

  it('escapes double quotes in notes', () => {
    const candidate: FactCandidate = {
      ...baseCandidate,
      note: 'Said "this is a note" in an interview',
    };
    const yaml = generateYamlBlock(candidate);
    expect(yaml).toContain("note: \"Said 'this is a note' in an interview\"");
  });

  it('handles candidates without optional fields', () => {
    const minimal: FactCandidate = {
      id: 'deadbeef',
      entity: 'anthropic',
      factId: 'revenue-2025',
      label: 'Anthropic revenue',
      value: 9000000000,
      asOf: '2025',
      confidence: 'medium',
      reason: 'Widely cited figure',
      rawContext: 'revenue of $9B',
    };
    const yaml = generateYamlBlock(minimal);
    expect(yaml).toContain('deadbeef:');
    expect(yaml).toContain('label: "Anthropic revenue"');
    expect(yaml).toContain('value: 9000000000');
    expect(yaml).not.toContain('measure:');
    expect(yaml).not.toContain('source:');
    expect(yaml).not.toContain('note:');
  });
});
