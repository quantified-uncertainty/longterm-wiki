/**
 * Tests for CI hallucination risk scoring helpers
 *
 * Focus areas:
 * - buildRiskSummary: generates correct markdown tables
 * - High-risk detection logic
 */

import { describe, it, expect } from 'vitest';
import { buildRiskSummary } from './ci-risk-scores.ts';
import type { PageRiskResult } from './ci-risk-scores.ts';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeResult(overrides: Partial<PageRiskResult> = {}): PageRiskResult {
  return {
    pageId: 'test-page',
    riskScore: 20,
    riskLevel: 'low',
    totalCitations: 10,
    riskFactors: [],
    ...overrides,
  };
}

// ── buildRiskSummary ────────────────────────────────────────────────────────

describe('buildRiskSummary', () => {
  it('generates table with low-risk pages', () => {
    const pages = [makeResult({ pageId: 'safe-page', riskScore: 15, riskLevel: 'low' })];
    const md = buildRiskSummary(pages);

    expect(md).toContain('| `safe-page` | 15 | low |');
    expect(md).not.toContain('High-risk pages detected');
  });

  it('bolds scores for high and medium risk pages', () => {
    const pages = [
      makeResult({ pageId: 'risky-page', riskScore: 65, riskLevel: 'high', riskFactors: ['no-citations', 'biographical-claims'] }),
      makeResult({ pageId: 'medium-page', riskScore: 35, riskLevel: 'medium', riskFactors: ['few-citations'] }),
    ];
    const md = buildRiskSummary(pages);

    expect(md).toContain('**65**');
    expect(md).toContain('**35**');
    expect(md).toContain('no-citations, biographical-claims');
    expect(md).toContain('High-risk pages detected');
  });

  it('handles empty page list', () => {
    const md = buildRiskSummary([]);
    expect(md).toContain('No pages to assess');
  });

  it('shows dash for pages with no risk factors', () => {
    const pages = [makeResult({ pageId: 'clean-page', riskFactors: [] })];
    const md = buildRiskSummary(pages);

    expect(md).toContain('| - |');
  });

  it('handles unknown risk level', () => {
    const pages = [makeResult({ pageId: 'unknown-page', riskLevel: 'unknown', riskScore: 0 })];
    const md = buildRiskSummary(pages);

    expect(md).toContain('`unknown-page`');
    expect(md).toContain('unknown');
  });

  it('does not show high-risk warning when only medium/low pages', () => {
    const pages = [
      makeResult({ riskLevel: 'medium', riskScore: 30 }),
      makeResult({ riskLevel: 'low', riskScore: 10 }),
    ];
    const md = buildRiskSummary(pages);

    expect(md).not.toContain('High-risk pages detected');
  });
});
