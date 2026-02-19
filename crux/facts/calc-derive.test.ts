/**
 * Tests for calc derivation utilities.
 *
 * Tests the pure helper functions (pattern detection, MDX transformation,
 * expression evaluation) without requiring LLM API calls or file I/O.
 */

import { describe, it, expect } from 'vitest';
import { evalCalcExpr, extractFactRefs } from '../lib/calc-evaluator.ts';
import {
  detectPatterns,
  buildCalcComponent,
  ensureCalcImport,
  validateOriginalText,
  type CalcProposal,
  type DetectedPattern,
} from './calc-derive.ts';

// ---------------------------------------------------------------------------
// Tests: calc-evaluator (evalCalcExpr / extractFactRefs)
// ---------------------------------------------------------------------------

describe('evalCalcExpr', () => {
  const lookup = (entity: string, factId: string): number | undefined => {
    const facts: Record<string, Record<string, number>> = {
      anthropic: {
        valuation: 380_000_000_000,
        'revenue-run-rate': 14_000_000_000,
        'valuation-nov-2025': 350_000_000_000,
        'revenue-arr-2025': 9_000_000_000,
      },
      openai: {
        valuation: 500_000_000_000,
        revenue: 20_000_000_000,
      },
    };
    return facts[entity]?.[factId];
  };

  it('evaluates a simple division', () => {
    const result = evalCalcExpr('{anthropic.valuation} / {anthropic.revenue-run-rate}', lookup);
    expect(result).toBeCloseTo(380_000_000_000 / 14_000_000_000, 1);
  });

  it('evaluates a growth rate expression', () => {
    // (14B / 9B - 1) * 100 ≈ 55.6%
    const result = evalCalcExpr(
      '({anthropic.valuation} / {anthropic.valuation-nov-2025} - 1) * 100',
      lookup
    );
    expect(result).toBeCloseTo((380 / 350 - 1) * 100, 1);
  });

  it('evaluates a difference expression', () => {
    const result = evalCalcExpr(
      '{openai.valuation} - {anthropic.valuation}',
      lookup
    );
    expect(result).toBe(120_000_000_000);
  });

  it('throws on unknown fact reference', () => {
    expect(() => evalCalcExpr('{anthropic.nonexistent}', lookup)).toThrow('Unknown or non-numeric fact');
  });

  it('throws on malformed reference (no dot)', () => {
    expect(() => evalCalcExpr('{badref}', lookup)).toThrow('Invalid fact reference');
  });

  it('evaluates expressions with no fact refs (plain math)', () => {
    // evalCalcExpr with no refs just evaluates the math
    expect(evalCalcExpr('2 + 2', _ref => undefined)).toBe(4);
  });

  it('handles power operator', () => {
    expect(evalCalcExpr('2 ^ 10', _ref => undefined)).toBe(1024);
  });
});

describe('extractFactRefs', () => {
  it('extracts single ref', () => {
    const refs = extractFactRefs('{anthropic.valuation}');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({ entity: 'anthropic', factId: 'valuation' });
  });

  it('extracts multiple refs', () => {
    const refs = extractFactRefs('{anthropic.valuation} / {anthropic.revenue-run-rate}');
    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual({ entity: 'anthropic', factId: 'valuation' });
    expect(refs[1]).toEqual({ entity: 'anthropic', factId: 'revenue-run-rate' });
  });

  it('handles refs from different entities', () => {
    const refs = extractFactRefs('{openai.valuation} - {anthropic.valuation}');
    expect(refs).toHaveLength(2);
    expect(refs[0].entity).toBe('openai');
    expect(refs[1].entity).toBe('anthropic');
  });

  it('returns empty array for expression with no refs', () => {
    const refs = extractFactRefs('2 + 2');
    expect(refs).toHaveLength(0);
  });

  it('handles hyphenated fact IDs', () => {
    const refs = extractFactRefs('{anthropic.revenue-arr-2025}');
    expect(refs[0]).toEqual({ entity: 'anthropic', factId: 'revenue-arr-2025' });
  });
});

// ---------------------------------------------------------------------------
// Tests: detectPatterns
// ---------------------------------------------------------------------------

describe('detectPatterns', () => {
  it('detects approximate multiples like ≈27x', () => {
    const body = 'Anthropic trades at ≈27x current revenue.';
    const patterns = detectPatterns(body);
    expect(patterns.length).toBeGreaterThanOrEqual(1);
    expect(patterns[0].match).toBe('≈27x');
    expect(patterns[0].approximateValue).toBe(27);
    expect(patterns[0].patternType).toBe('approximate multiple (≈Nx)');
  });

  it('detects tilde multiples like ~42x', () => {
    const body = 'The company trades at ~42x its revenue.';
    const patterns = detectPatterns(body);
    expect(patterns.some(p => p.match.includes('42x'))).toBe(true);
  });

  it('detects named multiples like "27x revenue"', () => {
    const body = 'That is 27x revenue for the company.';
    const patterns = detectPatterns(body);
    expect(patterns.some(p => p.match.toLowerCase().includes('27x revenue'))).toBe(true);
  });

  it('detects fold changes like "300-fold increase"', () => {
    const body = 'Training efficiency improved 300-fold increase over the baseline.';
    const patterns = detectPatterns(body);
    expect(patterns.some(p => p.match.toLowerCase().includes('fold'))).toBe(true);
  });

  it('detects ratio patterns like "3:1 ratio"', () => {
    const body = 'The split is a 3:1 ratio between the two groups.';
    const patterns = detectPatterns(body);
    expect(patterns.some(p => p.match.includes('3:1 ratio'))).toBe(true);
  });

  it('does not detect patterns inside <Calc> tags', () => {
    const body = 'Revenue multiple: <Calc expr="{a.b} / {a.c}" suffix="x" prefix="≈" />';
    const patterns = detectPatterns(body);
    expect(patterns).toHaveLength(0);
  });

  it('does not detect patterns inside fenced code blocks', () => {
    const body = '```\n≈27x revenue\n```\nThis is outside the code block.';
    const patterns = detectPatterns(body);
    expect(patterns).toHaveLength(0);
  });

  it('deduplicates identical patterns on the same line', () => {
    const body = '≈27x revenue and ≈27x something';
    const patterns = detectPatterns(body);
    // Each unique (line, match) pair appears only once
    const keys = patterns.map(p => `${p.line}:${p.match}`);
    const unique = new Set(keys);
    expect(keys.length).toBe(unique.size);
  });

  it('skips table separator rows', () => {
    const body = '| Header |\n|--------|\n| ≈27x revenue |';
    const patterns = detectPatterns(body);
    // Should detect the ≈27x in the content row but not a separator
    expect(patterns.every(p => p.match !== '')).toBe(true);
  });

  it('returns empty array for clean content', () => {
    const body = 'Anthropic raised $30B in Series G funding, reaching $380B valuation.';
    const patterns = detectPatterns(body);
    expect(patterns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: buildCalcComponent
// ---------------------------------------------------------------------------

describe('buildCalcComponent', () => {
  const baseProposal: CalcProposal = {
    originalText: '≈27x',
    expr: '{anthropic.valuation} / {anthropic.revenue-run-rate}',
    precision: 0,
    suffix: 'x',
    prefix: '≈',
    confidence: 'high',
    explanation: 'valuation divided by revenue',
    valid: true,
  };

  it('generates a self-closing Calc component', () => {
    const comp = buildCalcComponent(baseProposal);
    expect(comp).toBe(
      '<Calc expr="{anthropic.valuation} / {anthropic.revenue-run-rate}" precision={0} prefix="≈" suffix="x" />'
    );
  });

  it('omits optional props when not set', () => {
    const minimal: CalcProposal = {
      originalText: '≈27x',
      expr: '{a.b} / {a.c}',
      confidence: 'medium',
      explanation: 'test',
    };
    const comp = buildCalcComponent(minimal);
    expect(comp).toBe('<Calc expr="{a.b} / {a.c}" />');
    expect(comp).not.toContain('precision');
    expect(comp).not.toContain('suffix');
    expect(comp).not.toContain('prefix');
  });

  it('includes format prop when set', () => {
    const withFormat: CalcProposal = {
      ...baseProposal,
      format: 'currency',
      suffix: undefined,
      prefix: undefined,
    };
    const comp = buildCalcComponent(withFormat);
    expect(comp).toContain('format="currency"');
  });
});

// ---------------------------------------------------------------------------
// Tests: validateOriginalText
// ---------------------------------------------------------------------------

describe('validateOriginalText', () => {
  const pattern: DetectedPattern = {
    match: '≈25x',
    line: 1,
    context: 'test context',
    patternType: 'approximate multiple (≈Nx)',
    approximateValue: 25,
  };
  const baseProposal: CalcProposal = {
    originalText: '≈25x',
    expr: '{a.b} / {a.c}',
    confidence: 'high',
    explanation: 'test',
  };

  it('returns null for a valid originalText matching the pattern', () => {
    expect(validateOriginalText({ ...baseProposal, originalText: '≈25x' }, pattern)).toBeNull();
  });

  it('returns null when disambiguation adds ≤20 chars', () => {
    // "(current)" is 9 chars — within the 20-char budget
    expect(validateOriginalText({ ...baseProposal, originalText: '≈25x (current)' }, pattern)).toBeNull();
  });

  it('rejects originalText containing JSX/MDX tags', () => {
    const error = validateOriginalText(
      { ...baseProposal, originalText: '≈25x <F e="openai" f="123">$500B</F>' },
      pattern
    );
    expect(error).toMatch(/JSX\/MDX tags/);
  });

  it('rejects originalText wider than 20 chars above match length', () => {
    // "OpenAI's ≈25x. The valuation itself" is 24 chars wider than "≈25x"
    const error = validateOriginalText(
      { ...baseProposal, originalText: "OpenAI's ≈25x. The valuation itself" },
      pattern
    );
    expect(error).toMatch(/chars wider/);
  });

  it('rejects originalText containing a table pipe character', () => {
    const error = validateOriginalText({ ...baseProposal, originalText: '≈25x |' }, pattern);
    expect(error).toMatch(/table pipe/);
  });

  it('rejects originalText with a single table pipe for disambiguation', () => {
    const error = validateOriginalText({ ...baseProposal, originalText: '≈25x |' }, pattern);
    expect(error).toMatch(/table pipe/);
  });

  it('rejects suffix containing prose words', () => {
    const error = validateOriginalText(
      { ...baseProposal, originalText: '≈25x', suffix: 'x multiple at the previous' },
      pattern
    );
    expect(error).toMatch(/suffix.*prose/);
  });

  it('accepts short unit suffixes', () => {
    expect(validateOriginalText({ ...baseProposal, originalText: '≈25x', suffix: 'x' }, pattern)).toBeNull();
    expect(validateOriginalText({ ...baseProposal, originalText: '≈25x', suffix: '%' }, pattern)).toBeNull();
    expect(validateOriginalText({ ...baseProposal, originalText: '≈25x', suffix: ' pp' }, pattern)).toBeNull();
  });
});

describe('ensureCalcImport', () => {
  it('does not duplicate existing Calc import from @components/facts', () => {
    const content = `---\ntitle: Test\n---\nimport {F, Calc} from '@components/facts';\n\nContent.`;
    const result = ensureCalcImport(content);
    const calcImportCount = (result.match(/import.*Calc.*@components\/facts/g) || []).length;
    expect(calcImportCount).toBe(1);
  });

  it('adds Calc to existing @components/facts import without it', () => {
    const content = `---\ntitle: Test\n---\nimport {F} from '@components/facts';\n\nContent.`;
    const result = ensureCalcImport(content);
    expect(result).toMatch(/import\s+\{F, Calc\}\s+from\s+['"]@components\/facts['"]/);
  });

  it('adds new import line after @components/wiki import', () => {
    const content = `---\ntitle: Test\n---\nimport {EntityLink} from '@components/wiki';\n\nContent.`;
    const result = ensureCalcImport(content);
    expect(result).toContain("import {Calc} from '@components/facts';");
  });

  it('adds import after frontmatter when no other imports exist', () => {
    const content = `---\ntitle: Test\n---\n\nContent here.`;
    const result = ensureCalcImport(content);
    expect(result).toContain("import {Calc} from '@components/facts';");
    // Frontmatter should still be intact
    expect(result).toContain('---\ntitle: Test\n---');
  });
});
