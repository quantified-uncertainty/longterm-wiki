import { describe, it, expect, vi } from 'vitest';
import {
  categorizeCommit,
  groupCommits,
  generateReleaseBody,
  evaluateReleasePreflight,
  fetchSubPrDeployTasks,
  commitShasInReleaseDiff,
} from './release.ts';
import type { DeployHealthStatus } from '../lib/pr-analysis/deploy-status.ts';

// ── categorizeCommit ─────────────────────────────────────────────────────────

describe('categorizeCommit', () => {
  it('categorizes feat commits', () => {
    expect(categorizeCommit('feat: add new feature')).toBe('features');
    expect(categorizeCommit('feat(scope): scoped feature')).toBe('features');
  });

  it('categorizes fix commits', () => {
    expect(categorizeCommit('fix: resolve bug')).toBe('fixes');
    expect(categorizeCommit('fix(auth): login issue')).toBe('fixes');
  });

  it('categorizes refactor commits', () => {
    expect(categorizeCommit('refactor: simplify logic')).toBe('refactoring');
    expect(categorizeCommit('refactor(api): clean up routes')).toBe('refactoring');
  });

  it('categorizes docs commits', () => {
    expect(categorizeCommit('docs: update readme')).toBe('docs');
  });

  it('categorizes infrastructure commits', () => {
    expect(categorizeCommit('chore: update deps')).toBe('infrastructure');
    expect(categorizeCommit('ci: fix workflow')).toBe('infrastructure');
    expect(categorizeCommit('build: update config')).toBe('infrastructure');
    expect(categorizeCommit('perf: optimize query')).toBe('infrastructure');
  });

  it('categorizes unknown commits as other', () => {
    expect(categorizeCommit('update something')).toBe('other');
    expect(categorizeCommit('initial commit')).toBe('other');
    expect(categorizeCommit('Merge pull request #123')).toBe('other');
  });
});

// ── groupCommits ─────────────────────────────────────────────────────────────

describe('groupCommits', () => {
  it('groups commits by category', () => {
    const subjects = [
      'feat: add login',
      'fix: resolve crash',
      'chore: update deps',
      'docs: update readme',
      'refactor: simplify auth',
      'something else',
    ];

    const groups = groupCommits(subjects);
    expect(groups.features).toEqual(['feat: add login']);
    expect(groups.fixes).toEqual(['fix: resolve crash']);
    expect(groups.infrastructure).toEqual(['chore: update deps']);
    expect(groups.docs).toEqual(['docs: update readme']);
    expect(groups.refactoring).toEqual(['refactor: simplify auth']);
    expect(groups.other).toEqual(['something else']);
  });

  it('handles empty input', () => {
    const groups = groupCommits([]);
    expect(groups.features).toEqual([]);
    expect(groups.fixes).toEqual([]);
    expect(groups.refactoring).toEqual([]);
    expect(groups.docs).toEqual([]);
    expect(groups.infrastructure).toEqual([]);
    expect(groups.other).toEqual([]);
  });

  it('handles all commits in one category', () => {
    const subjects = ['feat: one', 'feat: two', 'feat: three'];
    const groups = groupCommits(subjects);
    expect(groups.features).toHaveLength(3);
    expect(groups.fixes).toHaveLength(0);
  });
});

// ── generateReleaseBody ──────────────────────────────────────────────────────

describe('generateReleaseBody', () => {
  it('generates a basic release body', async () => {
    const body = await generateReleaseBody({
      date: '2026-03-04',
      ahead: 5,
      behind: 0,
      subjects: ['feat: add login', 'fix: crash on startup'],
      repoSlug: 'org/repo',
    });

    expect(body).toContain('## Release 2026-03-04');
    expect(body).toContain('**5 commits**');
    expect(body).toContain('### Features');
    expect(body).toContain('- feat: add login');
    expect(body).toContain('### Fixes');
    expect(body).toContain('- fix: crash on startup');
    expect(body).toContain('[Full diff](https://github.com/org/repo/compare/production...main)');
  });

  it('includes divergence warning when behind > 0', async () => {
    const body = await generateReleaseBody({
      date: '2026-03-04',
      ahead: 3,
      behind: 2,
      subjects: ['feat: something'],
      repoSlug: 'org/repo',
    });

    expect(body).toContain('> [!WARNING]');
    expect(body).toContain('**2 commits** not on main');
  });

  it('omits divergence warning when behind = 0', async () => {
    const body = await generateReleaseBody({
      date: '2026-03-04',
      ahead: 3,
      behind: 0,
      subjects: ['feat: something'],
      repoSlug: 'org/repo',
    });

    expect(body).not.toContain('[!WARNING]');
  });

  it('omits empty categories', async () => {
    const body = await generateReleaseBody({
      date: '2026-03-04',
      ahead: 1,
      behind: 0,
      subjects: ['feat: only features here'],
      repoSlug: 'org/repo',
    });

    expect(body).toContain('### Features');
    expect(body).not.toContain('### Fixes');
    expect(body).not.toContain('### Refactoring');
    expect(body).not.toContain('### Documentation');
    expect(body).not.toContain('### Infrastructure');
    expect(body).not.toContain('### Other');
  });

  it('handles empty subjects', async () => {
    const body = await generateReleaseBody({
      date: '2026-03-04',
      ahead: 0,
      behind: 0,
      subjects: [],
      repoSlug: 'org/repo',
    });

    expect(body).toContain('## Release 2026-03-04');
    expect(body).toContain('**0 commits**');
    expect(body).not.toContain('### Features');
  });

  it('groups all conventional commit types correctly', async () => {
    const body = await generateReleaseBody({
      date: '2026-03-04',
      ahead: 6,
      behind: 0,
      subjects: [
        'feat: new feature',
        'fix: bug fix',
        'refactor: code cleanup',
        'docs: update docs',
        'chore: update deps',
        'random commit message',
      ],
      repoSlug: 'org/repo',
    });

    expect(body).toContain('### Features');
    expect(body).toContain('### Fixes');
    expect(body).toContain('### Refactoring');
    expect(body).toContain('### Documentation');
    expect(body).toContain('### Infrastructure');
    expect(body).toContain('### Other');
  });
});

// ── evaluateReleasePreflight ─────────────────────────────────────────────────

describe('evaluateReleasePreflight', () => {
  const healthySuccess: DeployHealthStatus = {
    healthy: true,
    lastDeploy: {
      status: 'success',
      sha: 'abc1234567',
      url: 'https://github.com/org/repo/actions/runs/1',
      timestamp: '2026-04-12T10:00:00Z',
    },
    failingSince: null,
  };

  const failedDeploy: DeployHealthStatus = {
    healthy: false,
    lastDeploy: {
      status: 'failure',
      sha: 'def4567890',
      url: 'https://github.com/org/repo/actions/runs/2',
      timestamp: '2026-04-12T11:00:00Z',
    },
    failingSince: '2026-04-12T11:00:00Z',
  };

  it('passes when deploy healthy', () => {
    const decision = evaluateReleasePreflight(healthySuccess, { force: false });
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.warning).toBeNull();
  });

  it('passes when no prior deploy data (fail-open)', () => {
    const decision = evaluateReleasePreflight(
      { healthy: true, lastDeploy: null, failingSince: null },
      { force: false },
    );
    expect(decision.ok).toBe(true);
  });

  it('passes defensively when healthy=false but lastDeploy=null', () => {
    // Shouldn't happen per checkDeployHealth's contract, but guard anyway.
    const decision = evaluateReleasePreflight(
      { healthy: false, lastDeploy: null, failingSince: null },
      { force: false },
    );
    expect(decision.ok).toBe(true);
  });

  it('blocks when last deploy failed', () => {
    const decision = evaluateReleasePreflight(failedDeploy, { force: false });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toContain('failure');
      expect(decision.reason).toContain('def4567');
      expect(decision.reason).toContain('QUA-295');
      expect(decision.reason).toContain('--force');
      expect(decision.lastDeployUrl).toBe('https://github.com/org/repo/actions/runs/2');
    }
  });

  it('blocks when last deploy was cancelled', () => {
    const decision = evaluateReleasePreflight(
      {
        healthy: false,
        lastDeploy: {
          status: 'cancelled',
          sha: 'aaa1111222',
          url: 'https://github.com/org/repo/actions/runs/3',
          timestamp: '2026-04-12T12:00:00Z',
        },
        failingSince: '2026-04-12T12:00:00Z',
      },
      { force: false },
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain('cancelled');
  });

  it('--force bypasses failed deploy with a loud warning', () => {
    const decision = evaluateReleasePreflight(failedDeploy, { force: true });
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.warning).not.toBeNull();
      expect(decision.warning).toContain('--force override');
      expect(decision.warning).toContain('failure');
      expect(decision.warning).toContain('def4567');
      expect(decision.warning).toContain('https://github.com/org/repo/actions/runs/2');
    }
  });

  it('--force with healthy deploy still has no warning', () => {
    const decision = evaluateReleasePreflight(healthySuccess, { force: true });
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.warning).toBeNull();
  });
});

// ── fetchSubPrDeployTasks (QUA-756) ─────────────────────────────────────────

describe('fetchSubPrDeployTasks (QUA-756)', () => {
  const NOW = new Date().getTime();
  const DAY = 1000 * 60 * 60 * 24;

  const DEPLOY_TASK_BODY = [
    '## Deploy Checklist',
    '<!-- deploy-tasks:v1 -->',
    '- [ ] Restart wiki-server',
    '- [ ] Verify endpoint',
    '<!-- /deploy-tasks -->',
  ].join('\n');

  function prFixture(overrides: {
    number: number;
    sha?: string | null;
    body?: string | null;
    mergedDaysAgo?: number;
  }) {
    const merged = overrides.mergedDaysAgo ?? 1;
    return {
      number: overrides.number,
      title: `PR ${overrides.number}`,
      body: overrides.body ?? DEPLOY_TASK_BODY,
      merged_at: new Date(NOW - merged * DAY).toISOString(),
      merge_commit_sha:
        overrides.sha === undefined ? `sha-${overrides.number}` : overrides.sha,
      updated_at: new Date(NOW - merged * DAY).toISOString(),
    };
  }

  it('returns empty tasks when the release diff is empty (nothing to ship)', async () => {
    const api = vi.fn();
    const result = await fetchSubPrDeployTasks({
      releaseDiffShas: new Set(),
      api: api as never,
    });
    expect(result.tasks).toEqual([]);
    expect(result.truncated).toBe(false);
    // No PR pagination should occur — empty diff is a fast no-op.
    expect(api).not.toHaveBeenCalled();
  });

  it('only includes tasks from PRs whose merge commit is in the release diff', async () => {
    // PRs 100 and 101 are in the release diff; PR 200 (already-shipped) is not.
    const releaseDiffShas = new Set(['sha-100', 'sha-101']);

    const api = vi.fn(async (endpoint: string) => {
      if (endpoint.includes('/pulls?')) {
        return [
          prFixture({ number: 100 }),
          prFixture({ number: 101 }),
          prFixture({ number: 200 }), // already shipped — sha not in diff
        ];
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    });

    const { tasks, truncated } = await fetchSubPrDeployTasks({
      releaseDiffShas,
      api: api as never,
    });

    // Each in-diff PR contributes its 2 unchecked tasks; the already-shipped
    // PR contributes none. Tasks are tagged with their originating PR.
    expect(tasks).toHaveLength(4);
    expect(tasks).toEqual(
      expect.arrayContaining([
        'Restart wiki-server _(from PR #100)_',
        'Verify endpoint _(from PR #100)_',
        'Restart wiki-server _(from PR #101)_',
        'Verify endpoint _(from PR #101)_',
      ]),
    );
    // No tasks from PR #200 (already shipped).
    expect(tasks.some((t) => t.includes('PR #200'))).toBe(false);
    expect(truncated).toBe(false);
  });

  it('drops PRs with null merge_commit_sha defensively', async () => {
    // GitHub returns null merge_commit_sha for unmerged PRs and (briefly) for
    // newly-merged ones whose merge commit is still being computed. Either way
    // we cannot match SHA membership — drop them rather than over-include.
    const releaseDiffShas = new Set(['sha-100']);
    const api = vi.fn(async () => [
      prFixture({ number: 100 }),
      prFixture({ number: 101, sha: null }),
    ]);

    const { tasks } = await fetchSubPrDeployTasks({
      releaseDiffShas,
      api: api as never,
    });

    expect(tasks.every((t) => t.includes('PR #100'))).toBe(true);
    expect(tasks.some((t) => t.includes('PR #101'))).toBe(false);
  });

  it('skips PRs without a deploy-tasks block', async () => {
    const releaseDiffShas = new Set(['sha-100', 'sha-101']);
    const api = vi.fn(async () => [
      prFixture({ number: 100 }),
      prFixture({ number: 101, body: 'A regular PR body with no deploy section.' }),
    ]);

    const { tasks } = await fetchSubPrDeployTasks({
      releaseDiffShas,
      api: api as never,
    });

    expect(tasks.every((t) => t.includes('PR #100'))).toBe(true);
    expect(tasks.some((t) => t.includes('PR #101'))).toBe(false);
  });

  it('skips already-checked tasks within an in-diff PR', async () => {
    const partiallyCheckedBody = [
      '## Deploy Checklist',
      '<!-- deploy-tasks:v1 -->',
      '- [x] Already done',
      '- [ ] Still pending',
      '<!-- /deploy-tasks -->',
    ].join('\n');

    const releaseDiffShas = new Set(['sha-100']);
    const api = vi.fn(async () => [
      prFixture({ number: 100, body: partiallyCheckedBody }),
    ]);

    const { tasks } = await fetchSubPrDeployTasks({
      releaseDiffShas,
      api: api as never,
    });

    expect(tasks).toEqual(['Still pending _(from PR #100)_']);
  });

  it('repro for QUA-756: stale shipped tasks do NOT leak into next release', async () => {
    // Simulate the QUA-756 scenario: prior release (PR #4619) shipped PRs
    // #4587..#4617 with unchecked deploy tasks. The current release ships only
    // PRs #4624 + #4625. The new behaviour: only #4624 + #4625 contribute
    // tasks, even though #4587..#4617 have unchecked items still.
    const releaseDiffShas = new Set(['sha-4624', 'sha-4625']);
    const oldShippedPrs = [4587, 4588, 4589, 4590, 4596, 4599, 4600, 4601, 4608, 4613];
    const newPrs = [4624, 4625];
    const allPrs = [...oldShippedPrs, ...newPrs].map((n) =>
      prFixture({ number: n }),
    );
    const api = vi.fn(async () => allPrs);

    const { tasks } = await fetchSubPrDeployTasks({
      releaseDiffShas,
      api: api as never,
    });

    // Every task must be from #4624 or #4625; none from the prior release.
    for (const task of tasks) {
      const match = task.match(/from PR #(\d+)/);
      expect(match).not.toBeNull();
      const prNum = match ? Number(match[1]) : NaN;
      expect(newPrs).toContain(prNum);
    }
    // Each new PR contributes 2 unchecked tasks → 4 total.
    expect(tasks).toHaveLength(4);
  });

  it('propagates truncation signal from fetchMergedPrsInWindow (silent-drop guard)', async () => {
    // If GitHub pagination hits its page cap, PRs in the release diff but
    // past the cap are silently omitted from `tasks`. We MUST surface this
    // upstream so generateReleaseBody emits an operator-facing warning —
    // otherwise this is the same silent-drop class QUA-450 hardened against.
    //
    // To trip truncation: every page must be a FULL page (length === perPage,
    // default 100) and all updated_at must be inside the cutoff window. Then
    // fetchMergedPrsInWindow keeps paging until maxPages (default 10) and
    // exits the loop with truncated=true.
    const releaseDiffShas = new Set(['sha-1']);
    const fullPage = Array.from({ length: 100 }, (_, i) =>
      prFixture({ number: i + 1, mergedDaysAgo: 1 }),
    );
    const api = vi.fn(async () => fullPage);

    const { tasks, truncated } = await fetchSubPrDeployTasks({
      releaseDiffShas,
      api: api as never,
      lookbackDays: 365,
    });

    expect(tasks.length).toBeGreaterThan(0); // PR #1 is in the diff
    expect(truncated).toBe(true);
    // Sanity check we actually exhausted pagination, not just one call.
    expect(api).toHaveBeenCalledTimes(10);
  });

  it('uses 60-day default lookback when not specified', async () => {
    // The default lookback is 60 days. Verify by feeding in a 50d-old PR
    // (kept) and a 70d-old PR (cut by fetchMergedPrsInWindow's merged_at
    // filter) and omitting `lookbackDays` so the default applies.
    const releaseDiffShas = new Set(['sha-100', 'sha-101']);
    const api = vi.fn(async () => [
      prFixture({ number: 100, mergedDaysAgo: 50 }),
      prFixture({ number: 101, mergedDaysAgo: 70 }),
    ]);

    const { tasks } = await fetchSubPrDeployTasks({
      releaseDiffShas,
      api: api as never,
      // intentionally omit lookbackDays — exercises the SUB_PR_LOOKBACK_DAYS default
    });

    expect(tasks.some((t) => t.includes('PR #100'))).toBe(true);
    expect(tasks.some((t) => t.includes('PR #101'))).toBe(false);
  });
});

// ── commitShasInReleaseDiff (QUA-756) ───────────────────────────────────────

describe('commitShasInReleaseDiff (QUA-756)', () => {
  it('returns parsed SHA Set when origin/production and origin/main both exist', () => {
    const gitFn = vi.fn((..._args: string[]): string => {
      const [cmd, ...rest] = _args;
      if (cmd === 'rev-parse') return 'abc123';
      if (cmd === 'log' && rest[0] === 'origin/production..origin/main') {
        return 'sha1\nsha2\nsha3';
      }
      throw new Error(`Unexpected git invocation: ${_args.join(' ')}`);
    });

    const result = commitShasInReleaseDiff(gitFn);
    expect(result).toEqual(new Set(['sha1', 'sha2', 'sha3']));
    // rev-parse + log = 2 calls.
    expect(gitFn).toHaveBeenCalledTimes(2);
  });

  it('returns empty Set when origin/production does not exist (first deploy / fresh clone)', () => {
    // git rev-parse --verify exits non-zero → execFileSync throws. We must
    // NOT swallow this with a generic warning that hides the missing branch.
    // Instead the caller should treat it as "no release diff" — same semantics
    // as a legitimately empty diff.
    const gitFn = vi.fn((..._args: string[]): string => {
      if (_args[0] === 'rev-parse') {
        throw new Error("fatal: Needed a single revision");
      }
      throw new Error('log should not run when production missing');
    });

    const result = commitShasInReleaseDiff(gitFn);
    expect(result).toEqual(new Set());
    // log MUST NOT be invoked after rev-parse fails.
    expect(gitFn).toHaveBeenCalledTimes(1);
    expect(gitFn).toHaveBeenCalledWith('rev-parse', '--verify', 'origin/production');
  });

  it('returns empty Set when production and main are at the same commit (legitimately empty diff)', () => {
    const gitFn = vi.fn((..._args: string[]): string => {
      if (_args[0] === 'rev-parse') return 'abc123';
      if (_args[0] === 'log') return ''; // empty diff
      throw new Error('unexpected');
    });

    const result = commitShasInReleaseDiff(gitFn);
    expect(result).toEqual(new Set());
  });

  it('handles trailing newlines in git log output', () => {
    const gitFn = vi.fn((..._args: string[]): string => {
      if (_args[0] === 'rev-parse') return 'abc123';
      if (_args[0] === 'log') return 'sha1\nsha2\n'; // trailing newline
      throw new Error('unexpected');
    });

    const result = commitShasInReleaseDiff(gitFn);
    expect(result).toEqual(new Set(['sha1', 'sha2']));
    expect(result.size).toBe(2); // no empty-string entry from trailing newline
  });
});
