/**
 * Tests for CI citation verification helpers
 *
 * Focus areas:
 * - buildCitationSummary: generates correct markdown tables
 * - extractPageIdsFromReport: parses run report YAML
 */

import { describe, it, expect } from 'vitest';
import { buildCitationSummary, extractPageIdsFromReport } from './ci-verify-citations.ts';
import type { PageCitationResult } from './ci-verify-citations.ts';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeResult(overrides: Partial<PageCitationResult> = {}): PageCitationResult {
  return {
    pageId: 'test-page',
    totalCitations: 5,
    verified: 5,
    broken: 0,
    unverifiable: 0,
    brokenUrls: [],
    ...overrides,
  };
}

// ── buildCitationSummary ────────────────────────────────────────────────────

describe('buildCitationSummary', () => {
  it('generates table with no broken citations', () => {
    const pages = [makeResult({ pageId: 'page-a', totalCitations: 8, verified: 8 })];
    const md = buildCitationSummary(pages);

    expect(md).toContain('| `page-a` | 8 | 8 | 0 |');
    expect(md).toContain('**Totals:** 8 verified, 0 broken');
    expect(md).not.toContain('Broken citation details');
  });

  it('bolds broken count and shows details when broken > 0', () => {
    const pages = [makeResult({
      pageId: 'page-b',
      totalCitations: 10,
      verified: 8,
      broken: 2,
      brokenUrls: [
        { url: 'https://example.com/dead', httpStatus: 404 },
        { url: 'https://example.com/gone', httpStatus: null },
      ],
    })];
    const md = buildCitationSummary(pages);

    expect(md).toContain('**2**');
    expect(md).toContain('Broken citation details');
    expect(md).toContain('https://example.com/dead (HTTP 404)');
    expect(md).toContain('https://example.com/gone (HTTP error)');
    expect(md).toContain('Warning: Broken citations detected');
  });

  it('handles empty page list', () => {
    const md = buildCitationSummary([]);
    expect(md).toContain('No pages to verify');
  });

  it('handles multiple pages with mixed results', () => {
    const pages = [
      makeResult({ pageId: 'good-page', totalCitations: 5, verified: 5, broken: 0 }),
      makeResult({
        pageId: 'bad-page',
        totalCitations: 3,
        verified: 1,
        broken: 2,
        brokenUrls: [{ url: 'https://x.com/1', httpStatus: 500 }],
      }),
    ];
    const md = buildCitationSummary(pages);

    expect(md).toContain('`good-page`');
    expect(md).toContain('`bad-page`');
    expect(md).toContain('**Totals:** 6 verified, 2 broken');
  });
});

// ── extractPageIdsFromReport ────────────────────────────────────────────────

describe('extractPageIdsFromReport', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ci-verify-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts successful page IDs from run report', () => {
    const reportPath = join(tmpDir, 'report.yaml');
    writeFileSync(reportPath, `
date: '2026-02-20'
execution:
  pagesUpdated: 2
  pagesFailed: 1
  pages:
    - pageId: existential-risk
      status: success
    - pageId: miri
      status: success
    - pageId: openai
      status: failed
`);

    const ids = extractPageIdsFromReport(reportPath);
    expect(ids).toEqual(['existential-risk', 'miri']);
  });

  it('returns empty array for missing file', () => {
    const ids = extractPageIdsFromReport('/nonexistent/report.yaml');
    expect(ids).toEqual([]);
  });

  it('returns empty array for malformed YAML', () => {
    const reportPath = join(tmpDir, 'bad.yaml');
    writeFileSync(reportPath, 'not: valid: yaml: [[[');
    const ids = extractPageIdsFromReport(reportPath);
    expect(ids).toEqual([]);
  });

  it('returns empty array when no pages in report', () => {
    const reportPath = join(tmpDir, 'empty.yaml');
    writeFileSync(reportPath, `
date: '2026-02-20'
execution:
  pagesUpdated: 0
`);

    const ids = extractPageIdsFromReport(reportPath);
    expect(ids).toEqual([]);
  });
});
