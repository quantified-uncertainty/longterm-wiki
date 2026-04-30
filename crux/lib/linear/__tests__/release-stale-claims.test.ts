/**
 * QUA-815 — tests for the stale-claim sweep.
 *
 * Three acceptance scenarios from the issue body are codified here as
 * top-level `describe` blocks so the test names mirror the spec:
 *
 *   - "stale row with no branch + no PR" → comment + state move
 *   - "stale row WITH a branch"          → no action (long-running protected)
 *   - "ticket in terminal state"         → no action (don't re-open closed work)
 *
 * Plus edge cases (open-PR protection, classify error tolerance, dry-run).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module mocks ────────────────────────────────────────────────────────────
// Mock dependencies BEFORE importing the SUT so the mocks are applied
// during the test module's own resolution.

const mockGetIssue = vi.fn();
const mockUpdateIssueState = vi.fn();
const mockCommentOnIssue = vi.fn();

vi.mock('../issues.ts', () => ({
  getIssue: mockGetIssue,
  updateIssueState: mockUpdateIssueState,
  commentOnIssue: mockCommentOnIssue,
}));

const mockGithubApi = vi.fn();

vi.mock('../../github.ts', () => ({
  githubApi: mockGithubApi,
  REPO: 'quantified-uncertainty/longterm-wiki',
}));

const mockGetStaleClaims = vi.fn();

vi.mock('../../wiki-server/agent-sessions.ts', () => ({
  getStaleClaims: mockGetStaleClaims,
}));

const mockGit = vi.fn();

vi.mock('../../git.ts', () => ({
  git: mockGit,
}));

// Now import the SUT — this evaluates the module body with mocks in place.
const {
  branchExistsForLinearId,
  findOpenPRsForLinearId,
  classifyStaleClaim,
  executeRelease,
  runStaleClaimSweep,
  humanizeStaleAge,
  AUTO_RELEASE_COMMENT_PREFIX,
} = await import('../release-stale-claims.ts');

// ── Helpers ────────────────────────────────────────────────────────────────

function makeClaim(overrides: Partial<{
  id: number;
  branch: string;
  linearId: string;
  slotNumber: number | null;
  status: string;
  startedAt: string;
  updatedAt: string;
}> = {}) {
  return {
    id: 42,
    branch: 'main',
    linearId: 'QUA-184',
    slotNumber: null,
    status: 'active',
    startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 60 * 60_000).toISOString(), // 60 min stale
    ...overrides,
  };
}

function makeIssue(stateName: string, stateType: string) {
  return {
    id: 'uuid-1',
    identifier: 'QUA-184',
    title: 'Test issue',
    description: '',
    priority: 3,
    url: 'https://linear.app/x/QUA-184',
    state: { id: 'state-1', name: stateName, type: stateType },
    team: { id: 'team-1', key: 'QUA' },
    parent: null,
    project: null,
    labels: { nodes: [] },
    children: { nodes: [] },
  };
}

beforeEach(() => {
  mockGetIssue.mockReset();
  mockUpdateIssueState.mockReset();
  mockCommentOnIssue.mockReset();
  mockGithubApi.mockReset();
  mockGetStaleClaims.mockReset();
  mockGit.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── humanizeStaleAge ────────────────────────────────────────────────────────

describe('humanizeStaleAge', () => {
  it('renders minutes for <1h', () => {
    const ts = new Date(Date.now() - 35 * 60_000).toISOString();
    expect(humanizeStaleAge(ts)).toMatch(/^3[45]min$/);
  });

  it('renders hours for <1d', () => {
    const ts = new Date(Date.now() - 5 * 60 * 60_000).toISOString();
    expect(humanizeStaleAge(ts)).toBe('5h');
  });

  it('renders days for >=1d', () => {
    const ts = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
    expect(humanizeStaleAge(ts)).toBe('3d');
  });

  it('falls back to raw string for invalid input', () => {
    expect(humanizeStaleAge('not-a-date')).toBe('not-a-date');
  });
});

// ── branchExistsForLinearId ─────────────────────────────────────────────────

describe('branchExistsForLinearId', () => {
  it('lowercases the linear-id and queries both exact + suffixed glob', () => {
    const runner = vi.fn().mockReturnValue('');
    branchExistsForLinearId('QUA-184', runner);
    expect(runner).toHaveBeenCalledWith(
      'ls-remote',
      '--heads',
      'origin',
      'claude/qua-184',
      'claude/qua-184-*',
    );
  });

  it('returns true when ls-remote reports any matching ref', () => {
    const runner = vi.fn().mockReturnValue(
      'abc123\trefs/heads/claude/qua-184-foo\n',
    );
    expect(branchExistsForLinearId('QUA-184', runner)).toBe(true);
  });

  it('returns false on empty output', () => {
    const runner = vi.fn().mockReturnValue('');
    expect(branchExistsForLinearId('QUA-184', runner)).toBe(false);
  });

  it('returns false on whitespace-only output', () => {
    const runner = vi.fn().mockReturnValue('   \n  \n');
    expect(branchExistsForLinearId('QUA-184', runner)).toBe(false);
  });
});

// ── findOpenPRsForLinearId ──────────────────────────────────────────────────

describe('findOpenPRsForLinearId', () => {
  it('rejects malformed linear ids without hitting GitHub', async () => {
    await expect(findOpenPRsForLinearId('bogus')).rejects.toThrow(/Invalid Linear ID/);
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('returns matching open PRs verified by word-boundary regex', async () => {
    mockGithubApi.mockResolvedValue({
      total_count: 2,
      items: [
        {
          number: 123,
          title: 'Fix QUA-184 bug',
          html_url: 'https://github.com/x/y/pull/123',
          body: 'Closes QUA-184',
          state: 'open',
        },
        // Adjacent id (QUA-1840) — must NOT match QUA-184 because of \b anchor
        {
          number: 124,
          title: 'Unrelated work on QUA-1840',
          html_url: 'https://github.com/x/y/pull/124',
          body: 'Some other ticket',
          state: 'open',
        },
      ],
    });
    const prs = await findOpenPRsForLinearId('QUA-184');
    expect(prs).toHaveLength(1);
    expect(prs[0].number).toBe(123);
  });

  it('matches a bare prose mention in the PR body', async () => {
    // Different from audit's close-keyword filter — even a "follow-up to QUA-184"
    // mention should protect the ticket.
    mockGithubApi.mockResolvedValue({
      total_count: 1,
      items: [
        {
          number: 200,
          title: 'Follow-up work',
          html_url: 'https://github.com/x/y/pull/200',
          body: 'Follow-up to QUA-184 — adds tests.',
          state: 'open',
        },
      ],
    });
    const prs = await findOpenPRsForLinearId('QUA-184');
    expect(prs).toHaveLength(1);
  });

  it('returns empty when GitHub finds nothing', async () => {
    mockGithubApi.mockResolvedValue({ total_count: 0, items: [] });
    expect(await findOpenPRsForLinearId('QUA-184')).toEqual([]);
  });

  it('rethrows rate-limit errors with a recognizable message', async () => {
    mockGithubApi.mockRejectedValue(new Error('GitHub API: rate limit exceeded'));
    await expect(findOpenPRsForLinearId('QUA-184')).rejects.toThrow(
      /rate limit exceeded/,
    );
  });
});

// ── classifyStaleClaim — the three acceptance scenarios ─────────────────────

describe('classifyStaleClaim — acceptance scenarios', () => {
  it('releases a stale row with no branch, no open PR, ticket In Progress', async () => {
    mockGit.mockReturnValue(''); // no branches
    mockGithubApi.mockResolvedValue({ total_count: 0, items: [] });
    mockGetIssue.mockResolvedValue(makeIssue('In Progress', 'started'));

    const claim = makeClaim();
    const { decision } = await classifyStaleClaim(claim);

    expect(decision.released).toBe(true);
    expect(decision.reason).toMatch(/stale .+, no branch, no open PR/);
  });

  it('skips a stale row WITH a branch on origin (long-running parent epic protection)', async () => {
    mockGit.mockReturnValue(
      'abc123\trefs/heads/claude/qua-408-phase-4b-things\n',
    );
    // The other checks should NOT be invoked once the branch check fires.
    const claim = makeClaim({ linearId: 'QUA-408' });
    const { decision } = await classifyStaleClaim(claim);

    expect(decision.released).toBe(false);
    expect(decision.reason).toMatch(/branch claude\/qua-408-\* exists/);
    expect(mockGithubApi).not.toHaveBeenCalled();
    expect(mockGetIssue).not.toHaveBeenCalled();
  });

  it('skips a stale row in a terminal Linear state (do not re-open closed work)', async () => {
    mockGit.mockReturnValue('');
    mockGithubApi.mockResolvedValue({ total_count: 0, items: [] });
    mockGetIssue.mockResolvedValue(makeIssue('Done', 'completed'));

    const { decision } = await classifyStaleClaim(makeClaim());

    expect(decision.released).toBe(false);
    expect(decision.reason).toMatch(/state is Done/);
  });

  it('skips a stale row in triage (human triage in progress)', async () => {
    mockGit.mockReturnValue('');
    mockGithubApi.mockResolvedValue({ total_count: 0, items: [] });
    mockGetIssue.mockResolvedValue(makeIssue('Triage', 'triage'));

    const { decision } = await classifyStaleClaim(makeClaim());

    expect(decision.released).toBe(false);
    expect(decision.reason).toMatch(/state is Triage/);
  });

  it('skips a stale row with an open PR (paranoia layer)', async () => {
    mockGit.mockReturnValue('');
    mockGithubApi.mockResolvedValue({
      total_count: 1,
      items: [
        {
          number: 4567,
          title: 'WIP: QUA-184 fix',
          html_url: 'https://github.com/x/y/pull/4567',
          body: 'Working on QUA-184',
          state: 'open',
        },
      ],
    });

    const { decision } = await classifyStaleClaim(makeClaim());

    expect(decision.released).toBe(false);
    expect(decision.reason).toMatch(/open PR #4567/);
    expect(mockGetIssue).not.toHaveBeenCalled();
  });

  it('skips when the Linear ticket has been deleted', async () => {
    mockGit.mockReturnValue('');
    mockGithubApi.mockResolvedValue({ total_count: 0, items: [] });
    mockGetIssue.mockResolvedValue(null);

    const { decision } = await classifyStaleClaim(makeClaim());

    expect(decision.released).toBe(false);
    expect(decision.reason).toMatch(/not found/);
  });
});

// ── executeRelease ──────────────────────────────────────────────────────────

describe('executeRelease', () => {
  it('posts the release comment first, then moves to Backlog', async () => {
    mockCommentOnIssue.mockResolvedValue(undefined);
    mockUpdateIssueState.mockResolvedValue({
      identifier: 'QUA-184',
      state: 'Backlog',
    });

    const order: string[] = [];
    mockCommentOnIssue.mockImplementation(async () => { order.push('comment'); });
    mockUpdateIssueState.mockImplementation(async () => {
      order.push('state');
      return { identifier: 'QUA-184', state: 'Backlog' };
    });

    await executeRelease(makeClaim(), 'stale 60min, no branch, no open PR');

    // Comment must be posted before state is updated, so the audit trail
    // captures the reason even if the state update later fails.
    expect(order).toEqual(['comment', 'state']);

    const [identifier, body] = mockCommentOnIssue.mock.calls[0];
    expect(identifier).toBe('QUA-184');
    expect(body).toContain(AUTO_RELEASE_COMMENT_PREFIX);
    expect(body).toContain('stale 60min');
  });
});

// ── runStaleClaimSweep ──────────────────────────────────────────────────────

describe('runStaleClaimSweep', () => {
  function setupClaimsResponse(claims: Array<ReturnType<typeof makeClaim>>) {
    mockGetStaleClaims.mockResolvedValue({
      ok: true as const,
      status: 200,
      data: {
        sessions: claims.map((c) => ({ ...c, linearId: c.linearId })),
        staleMinutes: 30,
        cutoff: new Date().toISOString(),
      },
    });
  }

  it('processes a mix of releasable + protected claims and reports both', async () => {
    setupClaimsResponse([
      makeClaim({ id: 1, linearId: 'QUA-100' }), // releasable
      makeClaim({ id: 2, linearId: 'QUA-101' }), // has branch
      makeClaim({ id: 3, linearId: 'QUA-102' }), // has open PR
    ]);

    // Per-claim mocks. Order matters: classifyStaleClaim runs the sequence
    // git → github → linear, so we mock all three for each candidate.
    mockGit.mockImplementation((..._args: string[]) => {
      const pattern = _args.find((a) => a.startsWith('claude/'));
      // QUA-101 has a branch; others don't.
      if (pattern?.includes('qua-101')) {
        return 'abc123\trefs/heads/claude/qua-101-foo\n';
      }
      return '';
    });
    mockGithubApi.mockImplementation(async (path: string) => {
      // QUA-102 has an open PR; others don't.
      if (path.includes('QUA-102')) {
        return {
          total_count: 1,
          items: [{
            number: 99,
            title: 'WIP: QUA-102',
            html_url: 'https://github.com/x/y/pull/99',
            body: 'closes QUA-102',
            state: 'open',
          }],
        };
      }
      return { total_count: 0, items: [] };
    });
    mockGetIssue.mockResolvedValue(makeIssue('In Progress', 'started'));
    mockCommentOnIssue.mockResolvedValue(undefined);
    mockUpdateIssueState.mockResolvedValue({ identifier: 'QUA-100', state: 'Backlog' });

    const report = await runStaleClaimSweep({});

    expect(report.candidates).toBe(3);
    expect(report.released).toBe(1);
    expect(report.skipped).toBe(2);
    expect(report.errors).toBe(0);

    // Only QUA-100 should have been commented + moved.
    expect(mockCommentOnIssue).toHaveBeenCalledTimes(1);
    expect(mockUpdateIssueState).toHaveBeenCalledTimes(1);
    expect(mockCommentOnIssue.mock.calls[0][0]).toBe('QUA-100');
  });

  it('dry-run does not mutate Linear even for releasable claims', async () => {
    setupClaimsResponse([makeClaim({ linearId: 'QUA-300' })]);
    mockGit.mockReturnValue('');
    mockGithubApi.mockResolvedValue({ total_count: 0, items: [] });
    mockGetIssue.mockResolvedValue(makeIssue('In Progress', 'started'));

    const report = await runStaleClaimSweep({ dryRun: true });

    expect(report.released).toBe(1);
    expect(mockCommentOnIssue).not.toHaveBeenCalled();
    expect(mockUpdateIssueState).not.toHaveBeenCalled();
  });

  it('continues after a per-claim error and counts it as `errors`', async () => {
    setupClaimsResponse([
      makeClaim({ id: 1, linearId: 'QUA-400' }),
      makeClaim({ id: 2, linearId: 'QUA-401' }),
    ]);
    // QUA-400 succeeds; QUA-401 fails during getIssue.
    mockGit.mockReturnValue('');
    mockGithubApi.mockResolvedValue({ total_count: 0, items: [] });
    mockGetIssue.mockImplementation(async (id: string) => {
      if (id === 'QUA-401') throw new Error('Linear API down');
      return makeIssue('In Progress', 'started');
    });
    mockCommentOnIssue.mockResolvedValue(undefined);
    mockUpdateIssueState.mockResolvedValue({ identifier: 'QUA-400', state: 'Backlog' });

    const report = await runStaleClaimSweep({});

    expect(report.candidates).toBe(2);
    expect(report.released).toBe(1);
    expect(report.errors).toBe(1);
    expect(report.results[1].decision.released).toBe(false);
    expect(report.results[1].decision.reason).toMatch(/Linear API down/);
  });

  it('streams per-claim results to the onResult callback', async () => {
    setupClaimsResponse([
      makeClaim({ id: 1, linearId: 'QUA-500' }),
      makeClaim({ id: 2, linearId: 'QUA-501' }),
    ]);
    mockGit.mockReturnValue('');
    mockGithubApi.mockResolvedValue({ total_count: 0, items: [] });
    mockGetIssue.mockResolvedValue(makeIssue('In Progress', 'started'));
    mockCommentOnIssue.mockResolvedValue(undefined);
    mockUpdateIssueState.mockResolvedValue({ identifier: 'QUA-500', state: 'Backlog' });

    const seen: string[] = [];
    await runStaleClaimSweep({
      onResult: (r) => { seen.push(r.claim.linearId); },
    });
    expect(seen).toEqual(['QUA-500', 'QUA-501']);
  });

  it('honors limit by truncating the candidate list', async () => {
    const claims = [1, 2, 3, 4, 5].map((n) =>
      makeClaim({ id: n, linearId: `QUA-${100 + n}` }),
    );
    setupClaimsResponse(claims);
    mockGit.mockReturnValue('abc\trefs/heads/claude/qua-foo\n'); // protect all
    const report = await runStaleClaimSweep({ limit: 2 });
    expect(report.candidates).toBe(2);
  });

  it('throws a clear error when wiki-server is unreachable', async () => {
    mockGetStaleClaims.mockResolvedValue({
      ok: false as const,
      status: 503,
      message: 'connection refused',
    });
    await expect(runStaleClaimSweep({})).rejects.toThrow(/connection refused/);
  });

  it('skips sessions where wiki-server returned a null linearId', async () => {
    // Defensive — server should never return this shape, but the type
    // signature allows it. The filter must drop these silently.
    mockGetStaleClaims.mockResolvedValue({
      ok: true as const,
      status: 200,
      data: {
        sessions: [
          { ...makeClaim({ id: 1 }), linearId: null },
          { ...makeClaim({ id: 2, linearId: 'QUA-700' }) },
        ],
        staleMinutes: 30,
        cutoff: new Date().toISOString(),
      },
    });
    mockGit.mockReturnValue('');
    mockGithubApi.mockResolvedValue({ total_count: 0, items: [] });
    mockGetIssue.mockResolvedValue(makeIssue('In Progress', 'started'));
    mockCommentOnIssue.mockResolvedValue(undefined);
    mockUpdateIssueState.mockResolvedValue({ identifier: 'QUA-700', state: 'Backlog' });

    const report = await runStaleClaimSweep({});
    expect(report.candidates).toBe(1);
  });
});
