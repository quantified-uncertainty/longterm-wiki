/**
 * Tests for crux/health/wellness-report.ts
 *
 * Verifies:
 *   - buildWellnessReport aggregates check results correctly
 *   - overallOk is true only when ALL checks pass
 *   - Markdown summary contains expected table rows and icons
 *   - Issue body has full detail sections
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CheckResult } from './health-check.ts';

// Mock GitHub so manageWellnessIssue tests don't touch the network. Keep the
// hoist-safe pattern from the rest of the codebase — the mocks are set up
// before the module under test is imported.
const mockListIssuesByLabel = vi.fn();
const mockListRecentOpenIssues = vi.fn();
const mockCreateIssueComment = vi.fn();
const mockCloseIssue = vi.fn();
const mockCreateIssue = vi.fn();
const mockEnsureLabel = vi.fn();
const mockGetGitHubToken = vi.fn();

vi.mock('../lib/github.ts', () => ({
  REPO: 'quantified-uncertainty/longterm-wiki',
  listIssuesByLabel: (...args: unknown[]) => mockListIssuesByLabel(...args),
  listRecentOpenIssues: (...args: unknown[]) => mockListRecentOpenIssues(...args),
  createIssueComment: (...args: unknown[]) => mockCreateIssueComment(...args),
  closeIssue: (...args: unknown[]) => mockCloseIssue(...args),
  createIssue: (...args: unknown[]) => mockCreateIssue(...args),
  ensureLabel: (...args: unknown[]) => mockEnsureLabel(...args),
  getGitHubToken: (...args: unknown[]) => mockGetGitHubToken(...args),
  isMissingTokenError: () => false,
  MISSING_TOKEN_SUMMARY: 'GITHUB_TOKEN not set',
}));

import {
  buildWellnessReport,
  manageWellnessIssue,
  prependMisconfigBanner,
  MISCONFIG_BANNER_MARKER,
  WELLNESS_ISSUE_TITLE,
} from './wellness-report.ts';

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

describe('manageWellnessIssue — Linear dedup wiring (QUA-577)', () => {
  const failingChecks = [makeCheck({ ok: false, summary: 'Data freshness failed' })];

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGitHubToken.mockReturnValue('fake-token');
    mockEnsureLabel.mockResolvedValue(undefined);
    mockListIssuesByLabel.mockResolvedValue([]);
    mockListRecentOpenIssues.mockResolvedValue([]);
  });

  it('skips GitHub create when Linear search returns an open match', async () => {
    const search = vi.fn().mockResolvedValue([
      {
        identifier: 'QUA-570',
        title: WELLNESS_ISSUE_TITLE,
        priority: 0,
        state: { name: 'Backlog', type: 'backlog' },
        url: 'https://linear.app/q/issue/QUA-570',
        createdAt: '2026-04-19T09:00:00.000Z',
        updatedAt: '2026-04-19T09:00:00.000Z',
      },
    ]);
    const comment = vi.fn().mockResolvedValue(undefined);
    const setState = vi.fn();

    const report = buildWellnessReport(failingChecks);
    const result = await manageWellnessIssue(report, {
      linearDedupDeps: {
        search,
        comment,
        setState,
        createIssue: vi.fn(),
        getProject: vi.fn(),
        now: () => Date.parse('2026-04-19T20:00:00.000Z'),
      },
    });

    expect(result.action).toBe('linear-commented');
    expect(result.linearIdentifier).toBe('QUA-570');
    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(comment).toHaveBeenCalledWith('QUA-570', expect.stringContaining('failing again'));
  });

  it('creates a Linear ticket directly (Linear-first) when no Linear match exists (QUA-970)', async () => {
    // Linear-first migration: instead of letting the GitHub-mirror sync produce
    // an orphan ticket without a project, file directly into Linear.
    const search = vi.fn().mockResolvedValue([]);
    const createIssue = vi
      .fn()
      .mockResolvedValue({ identifier: 'QUA-9999', url: 'https://linear.app/q/issue/QUA-9999' });
    const getProject = vi
      .fn()
      .mockResolvedValue({ id: 'project-uuid-aaaa', name: 'Automation & Infrastructure' });

    const report = buildWellnessReport(failingChecks);
    const result = await manageWellnessIssue(report, {
      linearDedupDeps: {
        search,
        comment: vi.fn(),
        setState: vi.fn(),
        createIssue,
        getProject,
        now: () => 0,
      },
    });

    expect(result.action).toBe('linear-created');
    expect(result.linearIdentifier).toBe('QUA-9999');
    // Critical: the GitHub create path must NOT have been taken.
    expect(mockCreateIssue).not.toHaveBeenCalled();
    // The Linear create must carry the wellness project so the ticket isn't orphaned.
    expect(getProject).toHaveBeenCalledWith('Automation & Infrastructure');
    expect(createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        title: WELLNESS_ISSUE_TITLE,
        projectId: 'project-uuid-aaaa',
      }),
    );
  });

  it('reopens a recently-closed Linear ticket when the dedup window applies (linear-reopened)', async () => {
    // Coverage for the third dedup branch (commented + reopened + skipped).
    // Verifies the wellness-report layer routes a `reopened` action correctly
    // and never reaches the new createLinearWellnessIssue path.
    const NOW = Date.parse('2026-04-19T20:00:00.000Z');
    const closedRecently = NOW - 6 * 60 * 60 * 1000; // 6h ago, well under the 48h reopen window
    const search = vi.fn().mockResolvedValue([
      {
        identifier: 'QUA-570',
        title: WELLNESS_ISSUE_TITLE,
        priority: 0,
        state: { name: 'Done', type: 'completed' },
        url: 'https://linear.app/q/issue/QUA-570',
        createdAt: new Date(closedRecently).toISOString(),
        updatedAt: new Date(closedRecently).toISOString(),
      },
    ]);
    const comment = vi.fn().mockResolvedValue(undefined);
    const setState = vi.fn().mockResolvedValue(undefined);
    const createIssue = vi.fn();
    const getProject = vi.fn();

    const report = buildWellnessReport(failingChecks);
    const result = await manageWellnessIssue(report, {
      linearDedupDeps: { search, comment, setState, createIssue, getProject, now: () => NOW },
    });

    expect(result.action).toBe('linear-reopened');
    expect(result.linearIdentifier).toBe('QUA-570');
    // Critical: neither the new Linear-create path nor the GH fallback should fire.
    expect(createIssue).not.toHaveBeenCalled();
    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(setState).toHaveBeenCalledWith('QUA-570', 'Backlog');
  });

  it('falls back to GitHub create on Linear lookup-failed without the misconfig banner', async () => {
    // Regression lock: the misconfig banner must NOT stamp on transient
    // lookup failures (Linear API down). The banner's "set the LINEAR_API_KEY
    // secret" advice doesn't apply, so leaving it off keeps the GH issue
    // accurate. If someone widens the misconfig predicate later, this test
    // would catch it.
    const search = vi.fn().mockRejectedValue(new Error('Linear API timed out'));
    mockCreateIssue.mockResolvedValue({ number: 9999 });

    vi.useFakeTimers();
    try {
      const report = buildWellnessReport(failingChecks);
      const promise = manageWellnessIssue(report, {
        linearDedupDeps: {
          search,
          comment: vi.fn(),
          setState: vi.fn(),
          createIssue: vi.fn(),
          getProject: vi.fn(),
          now: () => 0,
        },
      });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.action).toBe('created');
      expect(mockCreateIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.not.stringContaining(MISCONFIG_BANNER_MARKER),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to GitHub create on project-missing without the misconfig banner', async () => {
    // End-to-end coverage of the project-missing path: rename detection in
    // Linear should drop us to GH fallback (so the alert isn't lost) but
    // shouldn't stamp the misconfig banner (the cause is project rename,
    // not missing secret).
    const search = vi.fn().mockResolvedValue([]);
    const createIssue = vi.fn();
    const getProject = vi.fn().mockResolvedValue(null);
    mockCreateIssue.mockResolvedValue({ number: 9999 });

    vi.useFakeTimers();
    try {
      const report = buildWellnessReport(failingChecks);
      const promise = manageWellnessIssue(report, {
        linearDedupDeps: {
          search,
          comment: vi.fn(),
          setState: vi.fn(),
          createIssue,
          getProject,
          now: () => 0,
        },
      });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.action).toBe('created');
      expect(result.issueNumber).toBe(9999);
      // GH fallback fires — but the misconfig banner does NOT stamp.
      expect(mockCreateIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.not.stringContaining(MISCONFIG_BANNER_MARKER),
        }),
      );
      // Linear create should not be reached because project resolution failed.
      expect(createIssue).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to GitHub create when Linear create fails on api-error (no banner)', async () => {
    // Resilience: a transient Linear API error during create shouldn't drop
    // the alert. The GH fallback fires, but without the misconfig banner —
    // that banner is for the missing-secret case only.
    const search = vi.fn().mockResolvedValue([]);
    const apiError = new Error('Linear API unreachable');
    const createIssue = vi.fn().mockRejectedValue(apiError);
    const getProject = vi
      .fn()
      .mockResolvedValue({ id: 'project-uuid-aaaa', name: 'Automation & Infrastructure' });
    mockCreateIssue.mockResolvedValue({ number: 9999 });

    vi.useFakeTimers();
    try {
      const report = buildWellnessReport(failingChecks);
      const promise = manageWellnessIssue(report, {
        linearDedupDeps: {
          search,
          comment: vi.fn(),
          setState: vi.fn(),
          createIssue,
          getProject,
          now: () => 0,
        },
      });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.action).toBe('created');
      expect(result.issueNumber).toBe(9999);
      // GH fallback runs without the misconfig banner.
      expect(mockCreateIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.not.stringContaining(MISCONFIG_BANNER_MARKER),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not call the Linear dedup path when an open GitHub issue already exists', async () => {
    mockListIssuesByLabel.mockResolvedValue([{ number: 100, title: WELLNESS_ISSUE_TITLE }]);
    const search = vi.fn();

    const report = buildWellnessReport(failingChecks);
    const result = await manageWellnessIssue(report, {
      linearDedupDeps: {
        search,
        comment: vi.fn(),
        setState: vi.fn(),
        createIssue: vi.fn(),
        getProject: vi.fn(),
        now: () => 0,
      },
    });

    expect(result.action).toBe('updated');
    expect(result.issueNumber).toBe(100);
    expect(search).not.toHaveBeenCalled();
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it('stamps the misconfig banner on the new GitHub issue when LINEAR_API_KEY is missing (QUA-676)', async () => {
    // Reproduces the QUA-676 cascade: Linear-side dedup throws because the
    // secret is missing → caller falls through to GitHub createIssue. The new
    // issue body must carry the misconfig banner so whoever reads the ticket
    // sees the cause + the fix path. Without the banner, the duplicate cascade
    // recurs invisibly (which is what happened from QUA-577 → QUA-686).
    //
    // Post-QUA-970: Linear-first means we try createLinearWellnessIssue
    // BEFORE the GH fallback. The misconfig path must reject at search time
    // so we never reach Linear create either — otherwise the test would also
    // need to mock createIssue.
    const apiKeyError = new Error('LINEAR_API_KEY not set. Required for Linear API calls.');
    const search = vi.fn().mockRejectedValue(apiKeyError);
    mockCreateIssue.mockResolvedValue({ number: 4577 });
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    vi.useFakeTimers();
    try {
      const report = buildWellnessReport(failingChecks);
      const promise = manageWellnessIssue(report, {
        linearDedupDeps: {
          search,
          comment: vi.fn(),
          setState: vi.fn(),
          createIssue: vi.fn(),
          getProject: vi.fn(),
          now: () => 0,
        },
      });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.action).toBe('created');
      // The body argument to createIssue MUST start with the banner marker.
      // Substring check (not equality) leaves the rest of the body unconstrained
      // so the test isn't brittle to issue-body formatting tweaks.
      expect(mockCreateIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining(MISCONFIG_BANNER_MARKER),
        }),
      );
      // Misconfig must also fire the loud CI annotation, not just the body banner.
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('::error title=Wellness dedup misconfigured::'),
      );
    } finally {
      vi.useRealTimers();
      consoleLogSpy.mockRestore();
    }
  });

  it('closes a lingering open Linear ticket when checks recover and no GitHub issue is open', async () => {
    const search = vi.fn().mockResolvedValue([
      {
        identifier: 'QUA-570',
        title: WELLNESS_ISSUE_TITLE,
        priority: 0,
        state: { name: 'Backlog', type: 'backlog' },
        url: 'u',
        createdAt: '2026-04-19T09:00:00.000Z',
        updatedAt: '2026-04-19T09:00:00.000Z',
      },
    ]);
    const comment = vi.fn().mockResolvedValue(undefined);
    const setState = vi.fn().mockResolvedValue({ identifier: 'QUA-570', state: 'Done' });

    const passing = [makeCheck({ ok: true })];
    const report = buildWellnessReport(passing);
    const result = await manageWellnessIssue(report, {
      linearDedupDeps: {
        search,
        comment,
        setState,
        createIssue: vi.fn(),
        getProject: vi.fn(),
        now: () => 0,
      },
    });

    expect(result.action).toBe('closed');
    expect(result.linearIdentifier).toBe('QUA-570');
    expect(setState).toHaveBeenCalledWith('QUA-570', 'Done');
  });
});

describe('prependMisconfigBanner', () => {
  it('prepends the marker above the body content', () => {
    const out = prependMisconfigBanner('## Original body\n\nDetails here.');
    // Banner must appear FIRST so Linear's truncated GitHub-mirror preview
    // shows the cause, not the wellness check details.
    expect(out.indexOf(MISCONFIG_BANNER_MARKER)).toBe(0);
    expect(out).toContain('## Original body');
    expect(out).toContain('Details here.');
  });

  it('includes the secrets-page URL and the QUA-676 reference', () => {
    const out = prependMisconfigBanner('');
    expect(out).toContain('quantified-uncertainty/longterm-wiki/settings/secrets/actions');
    expect(out).toContain('QUA-676');
    expect(out).toContain('LINEAR_API_KEY');
  });
});
