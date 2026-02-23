/**
 * Tests for quality-gate.ts
 *
 * Covers:
 *  - Tier threshold calibration (#735)
 *  - Regression detection (word count, footnotes, tables)
 *  - Gap summary formatting
 */

import { describe, it, expect, vi } from 'vitest';
import { evaluateQualityGate } from './quality-gate.ts';
import type { OrchestratorContext, BudgetConfig } from './types.ts';
import { TIER_BUDGETS } from './types.ts';

// ---------------------------------------------------------------------------
// Mock the metrics extractor to return controlled values
// ---------------------------------------------------------------------------

vi.mock('./tools/index.ts', () => ({
  extractQualityMetrics: vi.fn(),
}));

import { extractQualityMetrics } from './tools/index.ts';
const mockMetrics = vi.mocked(extractQualityMetrics);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<OrchestratorContext> = {}): OrchestratorContext {
  return {
    page: { id: 'test-page', title: 'Test Page', path: '/test' },
    filePath: '/tmp/test.mdx',
    currentContent: '## Test\n\nImproved content.',
    originalContent: '## Test\n\nOriginal.',
    sourceCache: [],
    sections: null,
    splitPage: null,
    toolCallCount: 5,
    researchQueryCount: 2,
    costEntries: [],
    totalCost: 3.5,
    budget: TIER_BUDGETS.standard,
    directions: '',
    citationAudit: null,
    sectionDiffs: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Threshold calibration (#735)
// ---------------------------------------------------------------------------

describe('structuralScore thresholds (#735)', () => {
  it('standard tier passes with structuralScore=30', () => {
    const ctx = makeCtx({ budget: TIER_BUDGETS.standard });
    // Current: meets all thresholds
    mockMetrics.mockImplementation(() => ({
      wordCount: 1500,
      footnoteCount: 12,
      entityLinkCount: 8,
      diagramCount: 1,
      tableCount: 3,
      sectionCount: 6,
      structuralScore: 30,
    }));

    const result = evaluateQualityGate(ctx);
    const structuralGap = result.gaps.find(g => g.includes('Structural score'));
    expect(structuralGap).toBeUndefined();
  });

  it('deep tier passes with structuralScore=40', () => {
    const ctx = makeCtx({ budget: TIER_BUDGETS.deep });
    mockMetrics.mockImplementation(() => ({
      wordCount: 2000,
      footnoteCount: 20,
      entityLinkCount: 15,
      diagramCount: 2,
      tableCount: 5,
      sectionCount: 8,
      structuralScore: 40,
    }));

    const result = evaluateQualityGate(ctx);
    const structuralGap = result.gaps.find(g => g.includes('Structural score'));
    expect(structuralGap).toBeUndefined();
  });

  it('deep tier fails with structuralScore=39', () => {
    const ctx = makeCtx({ budget: TIER_BUDGETS.deep });
    mockMetrics.mockImplementation(() => ({
      wordCount: 2000,
      footnoteCount: 20,
      entityLinkCount: 15,
      diagramCount: 2,
      tableCount: 5,
      sectionCount: 8,
      structuralScore: 39,
    }));

    const result = evaluateQualityGate(ctx);
    const structuralGap = result.gaps.find(g => g.includes('Structural score'));
    expect(structuralGap).toBeDefined();
  });

  it('polish tier passes with structuralScore=30', () => {
    const ctx = makeCtx({ budget: TIER_BUDGETS.polish });
    mockMetrics.mockImplementation(() => ({
      wordCount: 800,
      footnoteCount: 5,
      entityLinkCount: 4,
      diagramCount: 0,
      tableCount: 1,
      sectionCount: 4,
      structuralScore: 30,
    }));

    const result = evaluateQualityGate(ctx);
    const structuralGap = result.gaps.find(g => g.includes('Structural score'));
    expect(structuralGap).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Regression detection
// ---------------------------------------------------------------------------

describe('regression detection', () => {
  it('detects table count regression', () => {
    const ctx = makeCtx();
    // First call = current metrics, second call = original metrics
    mockMetrics
      .mockReturnValueOnce({
        wordCount: 1500, footnoteCount: 10, entityLinkCount: 8,
        diagramCount: 1, tableCount: 2, sectionCount: 6, structuralScore: 35,
      })
      .mockReturnValueOnce({
        wordCount: 1200, footnoteCount: 8, entityLinkCount: 6,
        diagramCount: 1, tableCount: 5, sectionCount: 5, structuralScore: 30,
      });

    const result = evaluateQualityGate(ctx);
    expect(result.gaps.some(g => g.includes('Table count dropped'))).toBe(true);
  });

  it('detects significant word count decrease', () => {
    const ctx = makeCtx();
    mockMetrics
      .mockReturnValueOnce({
        wordCount: 500, footnoteCount: 10, entityLinkCount: 8,
        diagramCount: 1, tableCount: 3, sectionCount: 6, structuralScore: 35,
      })
      .mockReturnValueOnce({
        wordCount: 1500, footnoteCount: 8, entityLinkCount: 6,
        diagramCount: 1, tableCount: 3, sectionCount: 5, structuralScore: 30,
      });

    const result = evaluateQualityGate(ctx);
    expect(result.gaps.some(g => g.includes('Word count dropped'))).toBe(true);
  });

  it('detects citation count decrease', () => {
    const ctx = makeCtx();
    mockMetrics
      .mockReturnValueOnce({
        wordCount: 1500, footnoteCount: 3, entityLinkCount: 8,
        diagramCount: 1, tableCount: 3, sectionCount: 6, structuralScore: 35,
      })
      .mockReturnValueOnce({
        wordCount: 1200, footnoteCount: 10, entityLinkCount: 6,
        diagramCount: 1, tableCount: 3, sectionCount: 5, structuralScore: 30,
      });

    const result = evaluateQualityGate(ctx);
    expect(result.gaps.some(g => g.includes('Citation count dropped'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gate pass/fail
// ---------------------------------------------------------------------------

describe('gate pass/fail', () => {
  it('passes when all metrics meet thresholds and no regressions', () => {
    const ctx = makeCtx({ budget: TIER_BUDGETS.standard });
    mockMetrics.mockImplementation(() => ({
      wordCount: 1500,
      footnoteCount: 12,
      entityLinkCount: 8,
      diagramCount: 1,
      tableCount: 3,
      sectionCount: 6,
      structuralScore: 35,
    }));

    const result = evaluateQualityGate(ctx);
    expect(result.passed).toBe(true);
    expect(result.gapSummary).toBe('All quality checks passed.');
  });

  it('fails when content is unchanged', () => {
    const content = '## Test\n\nSame content.';
    const ctx = makeCtx({
      currentContent: content,
      originalContent: content,
      budget: TIER_BUDGETS.standard,
    });
    mockMetrics.mockImplementation(() => ({
      wordCount: 1500,
      footnoteCount: 12,
      entityLinkCount: 8,
      diagramCount: 1,
      tableCount: 3,
      sectionCount: 6,
      structuralScore: 35,
    }));

    const result = evaluateQualityGate(ctx);
    expect(result.passed).toBe(false);
    expect(result.gaps.some(g => g.includes('No changes'))).toBe(true);
  });
});
