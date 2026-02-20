/**
 * Tests for CI PR body builder
 *
 * Focus areas:
 * - buildPrBody: constructs correct PR body from components
 * - readRunReport: parses run report YAML
 */

import { describe, it, expect } from 'vitest';
import { buildPrBody, readRunReport } from './ci-pr-body.ts';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ── readRunReport ───────────────────────────────────────────────────────────

describe('readRunReport', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ci-pr-body-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads pages updated and budget from report', () => {
    const reportPath = join(tmpDir, 'report.yaml');
    writeFileSync(reportPath, `
date: '2026-02-20'
execution:
  pagesUpdated: 3
  pagesFailed: 0
budget:
  limit: 30
  spent: 18.5
`);

    const result = readRunReport(reportPath);
    expect(result.pagesUpdated).toBe(3);
    expect(result.budgetSpent).toBe(18.5);
  });

  it('returns zeros for missing file', () => {
    const result = readRunReport('/nonexistent/report.yaml');
    expect(result.pagesUpdated).toBe(0);
    expect(result.budgetSpent).toBe(0);
  });

  it('returns zeros for malformed YAML', () => {
    const reportPath = join(tmpDir, 'bad.yaml');
    writeFileSync(reportPath, '{not valid yaml');
    const result = readRunReport(reportPath);
    expect(result.pagesUpdated).toBe(0);
    expect(result.budgetSpent).toBe(0);
  });
});

// ── buildPrBody ─────────────────────────────────────────────────────────────

describe('buildPrBody', () => {
  it('generates basic PR body without summaries', () => {
    const body = buildPrBody({
      reportPath: null,
      date: '2026-02-20',
    });

    expect(body).toContain('## Auto-Update Run — 2026-02-20');
    expect(body).toContain('Automated news-driven wiki update');
    expect(body).toContain('citation audit gate');
    expect(body).toContain('This PR was created automatically');
    // No citation/risk sections
    expect(body).not.toContain('### Citation Verification');
    expect(body).not.toContain('### Hallucination Risk Scores');
  });

  it('includes citation summary when provided', () => {
    const body = buildPrBody({
      reportPath: null,
      date: '2026-02-20',
      citationSummary: '| Page | Verified |\n|------|----------|\n| `foo` | 5 |',
    });

    expect(body).toContain('### Citation Verification');
    expect(body).toContain('`foo`');
  });

  it('includes risk summary when provided', () => {
    const body = buildPrBody({
      reportPath: null,
      date: '2026-02-20',
      riskSummary: '| Page | Score |\n|------|-------|\n| `bar` | 65 |',
    });

    expect(body).toContain('### Hallucination Risk Scores');
    expect(body).toContain('`bar`');
  });

  it('includes both summaries in correct order (risk before citations)', () => {
    const body = buildPrBody({
      reportPath: null,
      date: '2026-02-20',
      citationSummary: 'citation data',
      riskSummary: 'risk data',
    });

    const riskIdx = body.indexOf('### Hallucination Risk Scores');
    const citIdx = body.indexOf('### Citation Verification');
    expect(riskIdx).toBeLessThan(citIdx);
  });

  it('reads report data when reportPath is provided', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ci-pr-body-test-'));
    const reportPath = join(tmpDir, 'report.yaml');
    writeFileSync(reportPath, `
execution:
  pagesUpdated: 4
budget:
  spent: 22
`);

    const body = buildPrBody({ reportPath, date: '2026-02-20' });
    expect(body).toContain('**Pages updated:** 4');
    expect(body).toContain('**Budget spent:** \\$22');

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
