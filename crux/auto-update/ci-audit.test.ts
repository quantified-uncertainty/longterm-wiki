/**
 * Tests for CI audit gate helpers
 *
 * Focus areas:
 * - buildMarkdownSummary: generates correct markdown tables and status
 * - Pass/fail logic based on inaccurate vs unsupported citations
 */

import { describe, it, expect } from 'vitest';
import { buildMarkdownSummary } from './ci-audit.ts';
import type { PageAuditResult } from './ci-audit.ts';
import type { AccuracyResult } from '../citations/check-accuracy.ts';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeAccuracy(overrides: Partial<AccuracyResult> = {}): AccuracyResult {
  return {
    pageId: 'test-page',
    total: 10,
    accurate: 8,
    minorIssues: 1,
    inaccurate: 0,
    unsupported: 1,
    notVerifiable: 0,
    errors: 0,
    issues: [],
    ...overrides,
  };
}

function makeResult(overrides: Partial<PageAuditResult> = {}): PageAuditResult {
  return {
    pageId: 'test-page',
    totalCitations: 10,
    auditRan: true,
    auditExitCode: 0,
    finalAccuracy: makeAccuracy(),
    ...overrides,
  };
}

// ── buildMarkdownSummary ────────────────────────────────────────────────────

describe('buildMarkdownSummary', () => {
  it('generates passing summary when no issues', () => {
    const results = [makeResult({ pageId: 'page-a', finalAccuracy: makeAccuracy({ inaccurate: 0, unsupported: 0 }) })];
    const md = buildMarkdownSummary(results, true);

    expect(md).toContain('## Citation Audit Results');
    expect(md).toContain('All pages passed');
    expect(md).toContain('`page-a`');
    expect(md).toContain('PASS');
    expect(md).not.toContain('FAIL');
  });

  it('generates failing summary when inaccurate citations exist', () => {
    const results = [makeResult({
      pageId: 'page-b',
      finalAccuracy: makeAccuracy({
        inaccurate: 2,
        issues: [
          { footnote: 1, verdict: 'inaccurate', score: 0.2, claim: 'bad claim', issues: ['wrong number'] },
          { footnote: 3, verdict: 'inaccurate', score: 0.3, claim: 'another bad', issues: ['misattributed'] },
        ],
      }),
    })];
    const md = buildMarkdownSummary(results, false);

    expect(md).toContain('Citation accuracy issues detected');
    expect(md).toContain('FAIL');
    expect(md).toContain('**2**'); // bold inaccurate count
    expect(md).toContain('Inaccurate citation details');
    expect(md).toContain('[^1]');
    expect(md).toContain('[^3]');
    expect(md).toContain('wrong number');
  });

  it('handles pages with no citations', () => {
    const results = [makeResult({
      pageId: 'empty-page',
      totalCitations: 0,
      auditRan: false,
      finalAccuracy: null,
    })];
    const md = buildMarkdownSummary(results, true);

    expect(md).toContain('`empty-page`');
    expect(md).toContain('No citations');
  });

  it('handles pages with errors', () => {
    const results = [makeResult({
      pageId: 'error-page',
      totalCitations: 5,
      auditRan: false,
      finalAccuracy: null,
      error: 'Page file not found',
    })];
    const md = buildMarkdownSummary(results, true);

    expect(md).toContain('`error-page`');
    expect(md).toContain('Page file not found');
  });

  it('handles mixed results (some pass, some fail)', () => {
    const results = [
      makeResult({ pageId: 'good-page', finalAccuracy: makeAccuracy({ inaccurate: 0 }) }),
      makeResult({
        pageId: 'bad-page',
        finalAccuracy: makeAccuracy({
          inaccurate: 1,
          issues: [{ footnote: 2, verdict: 'inaccurate', score: 0.1, claim: 'wrong', issues: ['error'] }],
        }),
      }),
    ];
    const md = buildMarkdownSummary(results, false);

    expect(md).toContain('`good-page`');
    expect(md).toContain('`bad-page`');
    expect(md).toContain('PASS');
    expect(md).toContain('FAIL');
  });

  it('bolds unsupported counts when > 0', () => {
    const results = [makeResult({
      finalAccuracy: makeAccuracy({ unsupported: 3, inaccurate: 0 }),
    })];
    const md = buildMarkdownSummary(results, true);

    expect(md).toContain('**3**');
  });

  it('shows 0 (not bold) when unsupported is 0', () => {
    const results = [makeResult({
      finalAccuracy: makeAccuracy({ unsupported: 0, inaccurate: 0 }),
    })];
    const md = buildMarkdownSummary(results, true);

    // The unsupported column should have plain "0", not "**0**"
    expect(md).toContain('| 0 | PASS |');
  });
});
