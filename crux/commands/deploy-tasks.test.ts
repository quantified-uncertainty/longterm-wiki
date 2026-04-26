/**
 * Tests for deploy-tasks command handlers.
 *
 * Covers:
 * - checkPsqlRunnable: gates psql verify commands when psql or DATABASE_URL
 *   are missing from the local environment (QUA-319).
 * - isPatBlockedError: detects GitHub PAT-blocked errors (QUA-409).
 * - isCommitOnProduction: unit tests for the compare-API helper (QUA-450).
 * - fetchMergedPrsInWindow: paginate-until-cutoff helper (QUA-450 review).
 * - commands.pending / commands.verify: integration-style tests that stub
 *   `githubApi` end-to-end so regressions in the roll-off wiring
 *   (`rolledOff`, `--include-deployed`) are caught even when
 *   `isCommitOnProduction` itself is correct (QUA-450 review).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the github lib before importing the command under test. We use
// `vi.hoisted()` so the mock functions are defined before the module factory
// runs — the module picks up the hoisted references, and each test can then
// call `mockGithubApi.mockImplementation(...)` to script responses.
const { mockGithubApi } = vi.hoisted(() => ({
  mockGithubApi: vi.fn(),
}));
vi.mock('../lib/github.ts', () => ({
  REPO: 'quantified-uncertainty/longterm-wiki',
  githubApi: mockGithubApi,
}));

import {
  checkPsqlRunnable,
  isPatBlockedError,
  isCommitOnProduction,
  fetchMergedPrsInWindow,
  commands,
} from './deploy-tasks.ts';

describe('checkPsqlRunnable', () => {
  const PSQL_CMD =
    'psql "$DATABASE_URL" -c "SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 5;"';
  const CURL_CMD = 'curl -sf "$WIKI_SERVER_URL/health" | jq .';

  it('returns runnable=true for non-psql commands regardless of env', () => {
    const result = checkPsqlRunnable(CURL_CMD, {
      hasPsql: () => false,
      getDatabaseUrl: () => undefined,
    });
    expect(result).toEqual({ runnable: true });
  });

  it('returns runnable=false with actionable reason when DATABASE_URL is unset', () => {
    const result = checkPsqlRunnable(PSQL_CMD, {
      hasPsql: () => true,
      getDatabaseUrl: () => undefined,
    });
    expect(result.runnable).toBe(false);
    if (!result.runnable) {
      expect(result.reason).toMatch(/DATABASE_URL is not set/);
      expect(result.reason).toMatch(/DB access|export DATABASE_URL/);
    }
  });

  it('returns runnable=false when DATABASE_URL is empty string', () => {
    const result = checkPsqlRunnable(PSQL_CMD, {
      hasPsql: () => true,
      getDatabaseUrl: () => '',
    });
    expect(result.runnable).toBe(false);
    if (!result.runnable) {
      expect(result.reason).toMatch(/DATABASE_URL is not set/);
    }
  });

  it('returns runnable=false when DATABASE_URL is whitespace-only', () => {
    const result = checkPsqlRunnable(PSQL_CMD, {
      hasPsql: () => true,
      getDatabaseUrl: () => '   ',
    });
    expect(result.runnable).toBe(false);
  });

  it('returns runnable=false with actionable reason when psql is not on PATH', () => {
    const result = checkPsqlRunnable(PSQL_CMD, {
      hasPsql: () => false,
      getDatabaseUrl: () => 'postgres://localhost/test',
    });
    expect(result.runnable).toBe(false);
    if (!result.runnable) {
      expect(result.reason).toMatch(/psql is not installed/);
      expect(result.reason).toMatch(/Install the Postgres client|machine with psql/);
    }
  });

  it('returns runnable=true when both psql is present and DATABASE_URL is set', () => {
    const result = checkPsqlRunnable(PSQL_CMD, {
      hasPsql: () => true,
      getDatabaseUrl: () => 'postgres://localhost/test',
    });
    expect(result).toEqual({ runnable: true });
  });

  it('prioritizes DATABASE_URL check over psql check', () => {
    // When both are missing, the DATABASE_URL message is more actionable
    // (env vars are faster to set than installing a binary).
    const result = checkPsqlRunnable(PSQL_CMD, {
      hasPsql: () => false,
      getDatabaseUrl: () => undefined,
    });
    expect(result.runnable).toBe(false);
    if (!result.runnable) {
      expect(result.reason).toMatch(/DATABASE_URL/);
      expect(result.reason).not.toMatch(/psql is not installed/);
    }
  });

  it('does not match commands that merely contain "psql" as a substring', () => {
    // `\bpsql\b` boundary means "psqlfoo" or "mypsql" shouldn't trigger
    const result = checkPsqlRunnable('echo mypsqlbar', {
      hasPsql: () => false,
      getDatabaseUrl: () => undefined,
    });
    expect(result).toEqual({ runnable: true });
  });
});

describe('isPatBlockedError (QUA-409)', () => {
  it('matches the canonical GitHub PAT error string', () => {
    expect(
      isPatBlockedError(
        'could not create workflow dispatch event: HTTP 403: Resource not accessible by personal access token',
      ),
    ).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isPatBlockedError('RESOURCE NOT ACCESSIBLE BY PERSONAL ACCESS TOKEN')).toBe(true);
  });

  it('matches fine-grained PAT / installation token variants', () => {
    expect(isPatBlockedError('HTTP 403: Resource not accessible by integration')).toBe(true);
    expect(isPatBlockedError('HTTP 403: Resource not accessible by user')).toBe(true);
  });

  it('does NOT match unrelated 403s or other errors', () => {
    expect(isPatBlockedError('HTTP 403: forbidden')).toBe(false);
    expect(isPatBlockedError('HTTP 403: Must have admin rights')).toBe(false);
    expect(isPatBlockedError('psql: connection refused')).toBe(false);
    expect(isPatBlockedError('HTTP 404: Not Found')).toBe(false);
  });

  it('handles empty / undefined output safely', () => {
    expect(isPatBlockedError(undefined)).toBe(false);
    expect(isPatBlockedError('')).toBe(false);
  });
});

describe('isCommitOnProduction (QUA-450)', () => {
  it('returns { on: true } when compare.ahead_by === 0 (commit is on production)', async () => {
    const api = vi.fn(async (..._args: unknown[]) => ({ ahead_by: 0, behind_by: 42 }));
    const res = await isCommitOnProduction('abc123', api as never);
    expect(res).toEqual({ on: true });
    expect(api.mock.calls[0][0]).toMatch(/compare\/production\.\.\.abc123/);
  });

  it('returns { on: false } when compare.ahead_by > 0 (commit ahead of production)', async () => {
    const api = vi.fn(async () => ({ ahead_by: 5, behind_by: 10 }));
    expect(await isCommitOnProduction('abc123', api as never)).toEqual({ on: false });
  });

  it('fail-open on API error: returns { on: false, error } so caller can log degraded behavior', async () => {
    const api = vi.fn(async () => {
      throw new Error('404 Not Found');
    });
    const res = await isCommitOnProduction('missing-sha', api as never);
    expect(res.on).toBe(false);
    expect(res.error).toMatch(/404 Not Found/);
  });

  it('returns { on: false } for empty sha without calling API', async () => {
    const api = vi.fn();
    expect(await isCommitOnProduction('', api as never)).toEqual({ on: false });
    expect(api).not.toHaveBeenCalled();
  });

  it('URL-encodes the commit sha', async () => {
    const api = vi.fn(async (..._args: unknown[]) => ({ ahead_by: 0 }));
    await isCommitOnProduction('weird/sha with spaces', api as never);
    expect(api.mock.calls[0][0]).toMatch(/weird%2Fsha%20with%20spaces/);
  });
});

// ---------------------------------------------------------------------------
// fetchMergedPrsInWindow (QUA-450 review)
// ---------------------------------------------------------------------------

describe('fetchMergedPrsInWindow (QUA-450 review)', () => {
  const NOW = new Date('2026-04-14T00:00:00Z').getTime();
  const DAY = 1000 * 60 * 60 * 24;

  // Helper: build a fake PrData-shaped row.
  function makePr(overrides: {
    number: number;
    mergedDaysAgo?: number | null;
    updatedDaysAgo: number;
    body?: string | null;
    title?: string;
  }) {
    return {
      number: overrides.number,
      title: overrides.title ?? `PR ${overrides.number}`,
      body: overrides.body ?? null,
      merged_at:
        overrides.mergedDaysAgo === undefined || overrides.mergedDaysAgo === null
          ? null
          : new Date(NOW - overrides.mergedDaysAgo * DAY).toISOString(),
      merge_commit_sha: `sha-${overrides.number}`,
      updated_at: new Date(NOW - overrides.updatedDaysAgo * DAY).toISOString(),
    };
  }

  it('paginates until a full page is past the cutoff and returns only merged-in-window PRs', async () => {
    // cutoff = 14 days ago
    const cutoff = new Date(NOW - 14 * DAY);

    // perPage = 2 so that each scripted page is "full" (won't trigger the
    // short-page stop condition). Stop condition must be "all updated_at past
    // cutoff", not "short page".
    const page1 = [
      makePr({ number: 1, mergedDaysAgo: 1, updatedDaysAgo: 0 }),
      makePr({ number: 2, mergedDaysAgo: null, updatedDaysAgo: 2 }), // closed not merged
    ];
    const page2 = [
      // Long-lived branch merged today — the old single-page `sort=created`
      // fetch missed exactly this case. `updated_at` is recent so we keep
      // going past this page.
      makePr({ number: 3, mergedDaysAgo: 0, updatedDaysAgo: 1 }),
      makePr({ number: 4, mergedDaysAgo: 8, updatedDaysAgo: 3 }),
    ];
    const page3 = [
      // First fully-past-cutoff page — `every updated_at < cutoff` trips,
      // so we stop here and do NOT fetch page 4.
      makePr({ number: 5, mergedDaysAgo: 60, updatedDaysAgo: 40 }),
      makePr({ number: 6, mergedDaysAgo: 90, updatedDaysAgo: 50 }),
    ];
    const page4 = [
      makePr({ number: 7, mergedDaysAgo: 100, updatedDaysAgo: 95 }),
      makePr({ number: 8, mergedDaysAgo: 120, updatedDaysAgo: 100 }),
    ];

    // Match `&page=N` (not `per_page=N`!) via the `&page=` prefix.
    const pageMatch = (endpoint: string): string => {
      const m = endpoint.match(/&page=(\d+)/);
      return m ? m[1] : '';
    };
    const api = vi.fn(async (endpoint: string) => {
      const p = pageMatch(endpoint);
      if (p === '1') return page1;
      if (p === '2') return page2;
      if (p === '3') return page3;
      if (p === '4') return page4;
      throw new Error(`Unexpected page fetch: ${endpoint}`);
    });

    const { prs, truncated } = await fetchMergedPrsInWindow(cutoff, api as never, {
      perPage: 2,
      maxPages: 10,
    });

    // Merged PRs inside the window: 1, 3, 4 (5 onwards are too old; 2 not merged).
    expect(prs.map((p) => p.number).sort()).toEqual([1, 3, 4]);
    // allPastCutoff on page 3 is a natural termination — not truncation.
    expect(truncated).toBe(false);
    // We should have made 3 calls — page 3 is where we stop (all past cutoff).
    // page=4 must NOT be fetched.
    expect(api).toHaveBeenCalledTimes(3);
    expect(api.mock.calls[0][0]).toMatch(/sort=updated&direction=desc/);
  });

  it('respects maxPages safety cap even if cutoff is never crossed', async () => {
    const cutoff = new Date(NOW - 365 * DAY);
    const api = vi.fn(async () => [
      makePr({ number: 1, mergedDaysAgo: 1, updatedDaysAgo: 0 }),
    ]);
    const { truncated } = await fetchMergedPrsInWindow(cutoff, api as never, {
      perPage: 1,
      maxPages: 2,
    });
    expect(api).toHaveBeenCalledTimes(2);
    // Hitting the cap without `allPastCutoff` or a short page is the exact
    // silent-loss case CodeRabbit flagged (comment 3077100107): we MUST report
    // the scan as truncated so callers can warn the operator.
    expect(truncated).toBe(true);
  });

  it('returns truncated=false when allPastCutoff fires naturally', async () => {
    // Every PR on page 1 is past the cutoff — `allPastCutoff` trips on page 1
    // and the loop exits naturally, so truncated MUST be false even though
    // maxPages=1 (i.e. the cap would have forced termination anyway).
    const cutoff = new Date(NOW - 14 * DAY);
    const api = vi.fn(async () => [
      makePr({ number: 1, mergedDaysAgo: 60, updatedDaysAgo: 40 }),
      makePr({ number: 2, mergedDaysAgo: 90, updatedDaysAgo: 50 }),
    ]);
    const { prs, truncated } = await fetchMergedPrsInWindow(cutoff, api as never, {
      perPage: 2,
      maxPages: 1,
    });
    expect(prs).toEqual([]); // both outside the window
    expect(truncated).toBe(false);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('stops on empty page', async () => {
    const cutoff = new Date(NOW - 14 * DAY);
    const api = vi
      .fn()
      .mockResolvedValueOnce([makePr({ number: 1, mergedDaysAgo: 1, updatedDaysAgo: 0 })])
      .mockResolvedValueOnce([]);
    const { prs, truncated } = await fetchMergedPrsInWindow(cutoff, api as never, {
      perPage: 1,
      maxPages: 5,
    });
    expect(prs.map((p) => p.number)).toEqual([1]);
    expect(truncated).toBe(false);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('returns truncated=false when a short final page terminates the scan', async () => {
    // perPage=2 and the final page returns only 1 row (< perPage). The
    // "short page" branch must set truncated=false so pending/verify don't
    // emit a spurious warning.
    const cutoff = new Date(NOW - 14 * DAY);
    const api = vi
      .fn()
      .mockResolvedValueOnce([
        makePr({ number: 1, mergedDaysAgo: 1, updatedDaysAgo: 0 }),
        makePr({ number: 2, mergedDaysAgo: 2, updatedDaysAgo: 1 }),
      ])
      .mockResolvedValueOnce([makePr({ number: 3, mergedDaysAgo: 3, updatedDaysAgo: 2 })]);
    const { prs, truncated } = await fetchMergedPrsInWindow(cutoff, api as never, {
      perPage: 2,
      maxPages: 5,
    });
    expect(prs.map((p) => p.number).sort()).toEqual([1, 2, 3]);
    expect(truncated).toBe(false);
    expect(api).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// commands.pending / commands.verify — end-to-end roll-off wiring (QUA-450 review)
//
// These are command-level integration tests that stub `githubApi` at the
// module boundary and invoke the exported `commands.pending` / `commands.verify`
// handlers exactly as the CLI does. They catch regressions where `pending` or
// `verify` stop honoring `rolledOff` / `--include-deployed` even when
// `isCommitOnProduction` is still correct in isolation.
// ---------------------------------------------------------------------------

describe('commands.pending — roll-off wiring (QUA-450 review)', () => {
  const NOW = new Date().getTime();
  const DAY = 1000 * 60 * 60 * 24;

  const DEPLOY_TASK_BODY = [
    '## Deploy Checklist',
    '<!-- deploy-tasks:v1 -->',
    '- [ ] Restart wiki-server',
    '<!-- /deploy-tasks -->',
  ].join('\n');

  function prFixture(number: number, mergedDaysAgo: number) {
    return {
      number,
      title: `PR ${number}`,
      body: DEPLOY_TASK_BODY,
      merged_at: new Date(NOW - mergedDaysAgo * DAY).toISOString(),
      merge_commit_sha: `sha-${number}`,
      updated_at: new Date(NOW - mergedDaysAgo * DAY).toISOString(),
    };
  }

  beforeEach(() => {
    mockGithubApi.mockReset();
  });

  it('rolls off PRs whose merge commit is already on production; surfaces rolledOff count', async () => {
    // pending() will:
    //   1. fetch /pulls (paginated) — return two PRs, stop after page 1
    //   2. for each candidate, fetch /compare/production...<sha>
    mockGithubApi.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/pulls?')) {
        return [prFixture(100, 1), prFixture(101, 2)];
      }
      if (endpoint.includes('/compare/production...sha-100')) {
        return { ahead_by: 0 }; // deployed — roll off
      }
      if (endpoint.includes('/compare/production...sha-101')) {
        return { ahead_by: 7 }; // not deployed — keep
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    });

    const result = await commands.pending([], { ci: true });
    const parsed = JSON.parse(result.output);

    expect(parsed.pendingPrs).toHaveLength(1);
    expect(parsed.pendingPrs[0].number).toBe(101);
    expect(parsed.rolledOff).toBe(1);
    expect(parsed.compareFailures).toBe(0);
  });

  it('keeps deployed PRs when --include-deployed is set; rolledOff and compareFailures both 0', async () => {
    mockGithubApi.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/pulls?')) {
        return [prFixture(200, 1), prFixture(201, 2)];
      }
      throw new Error(`Should not call compare when includeDeployed=true: ${endpoint}`);
    });

    const result = await commands.pending([], { ci: true, includeDeployed: true });
    const parsed = JSON.parse(result.output);

    // Both PRs kept; no compare calls made.
    expect(parsed.pendingPrs.map((p: { number: number }) => p.number).sort()).toEqual([200, 201]);
    expect(parsed.rolledOff).toBe(0);
    expect(parsed.compareFailures).toBe(0);
    // Assert the compare API was never called — short-circuit is critical
    // because the compare API is the expensive path.
    const compareCalls = mockGithubApi.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('/compare/'),
    );
    expect(compareCalls).toHaveLength(0);
  });

  it('surfaces compareFailures when the compare API errors; still fail-opens (keeps task visible)', async () => {
    mockGithubApi.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/pulls?')) return [prFixture(300, 1)];
      if (endpoint.includes('/compare/production...sha-300')) {
        throw new Error('HTTP 500: upstream connect error');
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    });

    const result = await commands.pending([], { ci: true });
    const parsed = JSON.parse(result.output);

    // Fail-open: the task stays visible, and `compareFailures` surfaces the
    // degraded roll-off so operators know `rolledOff: 0` may be misleading.
    expect(parsed.pendingPrs).toHaveLength(1);
    expect(parsed.rolledOff).toBe(0);
    expect(parsed.compareFailures).toBe(1);
  });
});

describe('commands.verify — roll-off wiring (QUA-450 review)', () => {
  const NOW = new Date().getTime();
  const DAY = 1000 * 60 * 60 * 24;

  // Verify iterates unchecked tasks and tries to run their embedded verify
  // commands. We use `--dry-run` so we don't actually execute anything.
  // The em-dash + backticked command is the canonical format parsed by
  // `extractVerifyCommand`.
  const DEPLOY_TASK_BODY = [
    '## Deploy Checklist',
    '<!-- deploy-tasks:v1 -->',
    '- [ ] `route` Check wiki-server health — `curl -sf "$WIKI_SERVER_URL/health" | jq .`',
    '<!-- /deploy-tasks -->',
  ].join('\n');

  function prFixture(number: number, mergedDaysAgo: number) {
    return {
      number,
      title: `PR ${number}`,
      body: DEPLOY_TASK_BODY,
      merged_at: new Date(NOW - mergedDaysAgo * DAY).toISOString(),
      merge_commit_sha: `sha-${number}`,
      updated_at: new Date(NOW - mergedDaysAgo * DAY).toISOString(),
    };
  }

  beforeEach(() => {
    mockGithubApi.mockReset();
  });

  it('rolls off deployed PRs before verification; rolledOff count reaches the summary', async () => {
    mockGithubApi.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/pulls?')) {
        return [prFixture(400, 1), prFixture(401, 2)];
      }
      if (endpoint.includes('/compare/production...sha-400')) return { ahead_by: 0 };
      if (endpoint.includes('/compare/production...sha-401')) return { ahead_by: 1 };
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    });

    const result = await commands.verify([], { ci: true, dryRun: true });
    const parsed = JSON.parse(result.output);

    // Only PR 401's task made it through to verification (as a dry-run skip).
    const verifiedPrs = [...new Set(parsed.results.map((r: { pr: number }) => r.pr))];
    expect(verifiedPrs).toEqual([401]);
    expect(parsed.summary.rolledOff).toBe(1);
    expect(parsed.summary.compareFailures).toBe(0);
  });

  it('--include-deployed runs verify for all PRs; rolledOff=0, no compare calls made', async () => {
    mockGithubApi.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/pulls?')) {
        return [prFixture(500, 1), prFixture(501, 2)];
      }
      throw new Error(`Should not call compare when includeDeployed=true: ${endpoint}`);
    });

    const result = await commands.verify([], {
      ci: true,
      dryRun: true,
      includeDeployed: true,
    });
    const parsed = JSON.parse(result.output);

    const verifiedPrs = [...new Set(parsed.results.map((r: { pr: number }) => r.pr))].sort();
    expect(verifiedPrs).toEqual([500, 501]);
    expect(parsed.summary.rolledOff).toBe(0);
    expect(parsed.summary.compareFailures).toBe(0);
    const compareCalls = mockGithubApi.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('/compare/'),
    );
    expect(compareCalls).toHaveLength(0);
  });

  it('surfaces compareFailures in the summary when compare API fails', async () => {
    mockGithubApi.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/pulls?')) return [prFixture(600, 1)];
      if (endpoint.includes('/compare/')) {
        throw new Error('HTTP 502 Bad Gateway');
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    });

    const result = await commands.verify([], { ci: true, dryRun: true });
    const parsed = JSON.parse(result.output);

    // Fail-open: PR is still verified.
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.summary.rolledOff).toBe(0);
    expect(parsed.summary.compareFailures).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// commands.pending / commands.verify — truncation surfacing
// (QUA-450 review follow-up — CodeRabbit comment 3077100107)
//
// `fetchMergedPrsInWindow` uses a hard `maxPages` safety cap. If the loop
// exhausts that cap without hitting `allPastCutoff` or a short/empty page,
// the result set is a partial scan and merged PRs on later pages are silently
// omitted — exactly the missing-task problem the first pagination fix was
// supposed to kill. These tests pin the contract that both `pending` and
// `verify` surface `truncated: true` in their CI JSON output so coordinators
// never trust a silently-truncated scan.
// ---------------------------------------------------------------------------

describe('commands.pending — truncation surfacing', () => {
  const NOW = new Date().getTime();
  const DAY = 1000 * 60 * 60 * 24;

  const DEPLOY_TASK_BODY = [
    '## Deploy Checklist',
    '<!-- deploy-tasks:v1 -->',
    '- [ ] Restart wiki-server',
    '<!-- /deploy-tasks -->',
  ].join('\n');

  function prFixture(number: number, mergedDaysAgo: number) {
    return {
      number,
      title: `PR ${number}`,
      body: DEPLOY_TASK_BODY,
      merged_at: new Date(NOW - mergedDaysAgo * DAY).toISOString(),
      merge_commit_sha: `sha-${number}`,
      updated_at: new Date(NOW - mergedDaysAgo * DAY).toISOString(),
    };
  }

  beforeEach(() => {
    mockGithubApi.mockReset();
  });

  it('emits truncated=true in CI JSON when every page is full and inside the cutoff window', async () => {
    // Every page returns a full 100 entries inside the cutoff — the loop
    // never hits `allPastCutoff` or a short page, so it exits only because
    // it reaches the default `maxPages=10` cap.
    let callCount = 0;
    mockGithubApi.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/pulls?')) {
        callCount++;
        // 100-row full page, all inside the 14-day window
        return Array.from({ length: 100 }, (_, i) =>
          prFixture(10_000 + callCount * 1000 + i, 1),
        );
      }
      if (endpoint.includes('/compare/')) {
        return { ahead_by: 7 }; // keep everything — no roll-off
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    });

    const result = await commands.pending([], { ci: true });
    const parsed = JSON.parse(result.output);

    expect(parsed.truncated).toBe(true);
    // Default maxPages=10 means we made exactly 10 pulls calls.
    const pullsCalls = mockGithubApi.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('/pulls?'),
    );
    expect(pullsCalls).toHaveLength(10);
  });

  it('emits truncated=false in CI JSON when a short page naturally terminates discovery', async () => {
    mockGithubApi.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/pulls?')) {
        // One short page — well under perPage=100 — terminates discovery
        // naturally. No truncation.
        return [prFixture(700, 1), prFixture(701, 2)];
      }
      if (endpoint.includes('/compare/')) {
        return { ahead_by: 7 };
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    });

    const result = await commands.pending([], { ci: true });
    const parsed = JSON.parse(result.output);

    expect(parsed.truncated).toBe(false);
  });
});

describe('commands.verify — truncation surfacing', () => {
  const NOW = new Date().getTime();
  const DAY = 1000 * 60 * 60 * 24;

  const DEPLOY_TASK_BODY = [
    '## Deploy Checklist',
    '<!-- deploy-tasks:v1 -->',
    '- [ ] `route` Check wiki-server health — `curl -sf "$WIKI_SERVER_URL/health" | jq .`',
    '<!-- /deploy-tasks -->',
  ].join('\n');

  function prFixture(number: number, mergedDaysAgo: number) {
    return {
      number,
      title: `PR ${number}`,
      body: DEPLOY_TASK_BODY,
      merged_at: new Date(NOW - mergedDaysAgo * DAY).toISOString(),
      merge_commit_sha: `sha-${number}`,
      updated_at: new Date(NOW - mergedDaysAgo * DAY).toISOString(),
    };
  }

  beforeEach(() => {
    mockGithubApi.mockReset();
  });

  it('emits truncated=true in the summary when every page is full and inside the window', async () => {
    let callCount = 0;
    mockGithubApi.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/pulls?')) {
        callCount++;
        return Array.from({ length: 100 }, (_, i) =>
          prFixture(20_000 + callCount * 1000 + i, 1),
        );
      }
      if (endpoint.includes('/compare/')) {
        return { ahead_by: 7 };
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    });

    const result = await commands.verify([], { ci: true, dryRun: true });
    const parsed = JSON.parse(result.output);

    expect(parsed.summary.truncated).toBe(true);
    const pullsCalls = mockGithubApi.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('/pulls?'),
    );
    expect(pullsCalls).toHaveLength(10);
  });

  it('emits truncated=false in the summary when discovery terminates naturally', async () => {
    mockGithubApi.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/pulls?')) {
        return [prFixture(800, 1), prFixture(801, 2)];
      }
      if (endpoint.includes('/compare/')) {
        return { ahead_by: 7 };
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    });

    const result = await commands.verify([], { ci: true, dryRun: true });
    const parsed = JSON.parse(result.output);

    expect(parsed.summary.truncated).toBe(false);
  });
});
