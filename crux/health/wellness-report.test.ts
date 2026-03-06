/**
 * Tests for crux/health/wellness-report.ts
 *
 * Verifies:
 *   - buildWellnessReport aggregates check results correctly
 *   - overallOk is true only when ALL checks pass
 *   - Markdown summary contains expected table rows and icons
 *   - Issue body has full detail sections
 */

import { describe, it, expect } from 'vitest';
import type { CheckResult } from './health-check.ts';
import { buildWellnessReport, WELLNESS_ISSUE_TITLE } from './wellness-report.ts';

function makeCheck(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    name: 'Test check',
    ok: true,
    summary: 'All good',
    detail: ['PASS  test line 1', 'PASS  test line 2'],
    ...overrides,
  };
}

describe('buildWellnessReport', () => {
  it('reports overallOk=true when all checks pass', () => {
    const checks = [
      makeCheck({ name: 'Server & DB', summary: '650 pages' }),
      makeCheck({ name: 'API smoke tests', summary: 'All 5 tests passed' }),
      makeCheck({ name: 'GitHub Actions', summary: 'All healthy' }),
    ];

    const report = buildWellnessReport(checks);

    expect(report.overallOk).toBe(true);
    expect(report.checks).toHaveLength(3);
    expect(report.markdownSummary).toContain(':white_check_mark:');
    expect(report.markdownSummary).toContain('All checks passed');
    expect(report.markdownSummary).not.toContain(':x:');
  });

  it('reports overallOk=false when any check fails', () => {
    const checks = [
      makeCheck({ name: 'Server & DB', ok: true }),
      makeCheck({ name: 'API smoke tests', ok: false, summary: '2 failures' }),
      makeCheck({ name: 'GitHub Actions', ok: true }),
    ];

    const report = buildWellnessReport(checks);

    expect(report.overallOk).toBe(false);
    expect(report.markdownSummary).toContain(':x:');
    expect(report.markdownSummary).toContain('Some checks failed');
  });

  it('includes table rows for each check in the summary', () => {
    const checks = [
      makeCheck({ name: 'Server & DB', ok: true, summary: 'Healthy' }),
      makeCheck({ name: 'Frontend', ok: false, summary: 'HTTP 500' }),
    ];

    const report = buildWellnessReport(checks);

    expect(report.markdownSummary).toContain('| Server & DB | :green_circle: | Healthy |');
    expect(report.markdownSummary).toContain('| Frontend | :red_circle: | HTTP 500 |');
  });

  it('includes collapsible details for checks with detail lines', () => {
    const checks = [
      makeCheck({
        name: 'Server & DB',
        detail: ['HTTP status: 200', 'Pages: 650'],
      }),
    ];

    const report = buildWellnessReport(checks);

    expect(report.markdownSummary).toContain('<details><summary>Server & DB details</summary>');
    expect(report.markdownSummary).toContain('HTTP status: 200');
    expect(report.markdownSummary).toContain('Pages: 650');
    expect(report.markdownSummary).toContain('</details>');
  });

  it('omits collapsible section for checks without detail', () => {
    const checks = [
      makeCheck({ name: 'Quick check', detail: undefined }),
    ];

    const report = buildWellnessReport(checks);

    expect(report.markdownSummary).not.toContain('<details><summary>Quick check details</summary>');
  });

  it('issue body contains section headers for each check', () => {
    const checks = [
      makeCheck({ name: 'Server & DB', detail: ['line1'] }),
      makeCheck({ name: 'API smoke tests', detail: ['line2'] }),
    ];

    const report = buildWellnessReport(checks);

    expect(report.issueBody).toContain('### Server & DB');
    expect(report.issueBody).toContain('### API smoke tests');
    expect(report.issueBody).toContain('line1');
    expect(report.issueBody).toContain('line2');
  });

  it('issue body contains workflow link footer', () => {
    const checks = [makeCheck()];
    const report = buildWellnessReport(checks);

    expect(report.issueBody).toContain('wellness check workflow');
    expect(report.issueBody).toContain('Closes automatically when all checks pass');
  });

  it('timestamp is included in both summary and issue body', () => {
    const checks = [makeCheck()];
    const report = buildWellnessReport(checks);

    // Timestamp should look like a UTC date-time
    expect(report.timestamp).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
    expect(report.markdownSummary).toContain(report.timestamp);
    expect(report.issueBody).toContain(report.timestamp);
  });

  it('handles empty checks array gracefully', () => {
    const report = buildWellnessReport([]);

    expect(report.overallOk).toBe(true);
    expect(report.checks).toHaveLength(0);
    expect(report.markdownSummary).toContain('All checks passed');
  });

  it('handles checks with empty detail arrays', () => {
    const checks = [makeCheck({ detail: [] })];
    const report = buildWellnessReport(checks);

    // Should not crash and should skip the collapsible section
    expect(report.markdownSummary).not.toContain('<details>');
  });
});

describe('WELLNESS_ISSUE_TITLE', () => {
  it('is a stable string without a timestamp', () => {
    // The title must be stable (no timestamp) so that concurrent workflow
    // runs can find each other's issues and avoid duplicates.
    expect(WELLNESS_ISSUE_TITLE).toBe('System wellness check failing');
    expect(WELLNESS_ISSUE_TITLE).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
