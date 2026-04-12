import { describe, it, expect } from 'vitest';

import {
  evaluateDeployStatus,
  evaluateMainCi,
  combineHealth,
  mapRollupState,
  DEPLOY_STUCK_MIN_CONSECUTIVE_FAILURES,
  MAIN_CI_RED_STREAK_MIN,
  DEPLOY_STALE_THRESHOLD_HOURS,
  DEPLOY_STUCK_SCORE,
  MAIN_CI_RED_SCORE,
  type WorkflowRun,
  type CommitStatus,
} from './health-scan.ts';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 1,
    conclusion: 'success',
    status: 'completed',
    createdAt: '2026-04-12T06:01:00Z',
    htmlUrl: 'https://github.com/example/run/1',
    displayTitle: 'Example run',
    headBranch: 'production',
    ...overrides,
  };
}

function commit(overrides: Partial<CommitStatus> = {}): CommitStatus {
  return {
    sha: 'abc123',
    url: 'https://github.com/example/commit/abc123',
    createdAt: '2026-04-12T06:01:00Z',
    conclusion: 'success',
    ...overrides,
  };
}

// ── evaluateDeployStatus ─────────────────────────────────────────────────────

describe('evaluateDeployStatus', () => {
  it('returns healthy when there are no runs', () => {
    const result = evaluateDeployStatus([]);
    expect(result.healthy).toBe(true);
    expect(result.failingDeploys).toHaveLength(0);
    expect(result.lastSuccessfulDeployAt).toBeNull();
  });

  it('returns healthy when the latest run succeeded', () => {
    const result = evaluateDeployStatus([
      run({ id: 1, conclusion: 'success', createdAt: '2026-04-12T06:00:00Z' }),
      run({ id: 2, conclusion: 'failure', createdAt: '2026-04-12T05:00:00Z' }),
    ]);
    expect(result.healthy).toBe(true);
    expect(result.reason).toMatch(/succeeded/);
    expect(result.lastSuccessfulDeployAt?.toISOString()).toBe('2026-04-12T06:00:00.000Z');
    expect(result.failingDeploys).toHaveLength(0);
  });

  it('treats a single recent failure as a flap (not yet unhealthy)', () => {
    const now = new Date('2026-04-12T07:00:00Z');
    const result = evaluateDeployStatus(
      [
        run({ id: 1, conclusion: 'failure', createdAt: '2026-04-12T06:30:00Z' }),
        run({ id: 2, conclusion: 'success', createdAt: '2026-04-12T06:00:00Z' }),
      ],
      now,
    );
    expect(result.healthy).toBe(true);
    expect(result.reason).toMatch(/flap/);
    expect(result.failingDeploys).toHaveLength(1);
  });

  it('flags deploy-stuck on ≥2 consecutive failures at the head', () => {
    const result = evaluateDeployStatus([
      run({ id: 1, conclusion: 'failure', createdAt: '2026-04-12T06:01:00Z', displayTitle: 'release #4180' }),
      run({ id: 2, conclusion: 'failure', createdAt: '2026-04-11T22:57:00Z', displayTitle: 'release #4167' }),
      run({ id: 3, conclusion: 'success', createdAt: '2026-04-11T18:29:00Z' }),
    ]);
    expect(result.healthy).toBe(false);
    expect(result.reason).toContain('2 consecutive');
    expect(result.reason).toContain('release #4180');
    expect(result.failingDeploys).toHaveLength(2);
    expect(result.failingDeploys[0].id).toBe(1);
    expect(result.lastSuccessfulDeployAt?.toISOString()).toBe('2026-04-11T18:29:00.000Z');
  });

  it('validates the consecutive-failures threshold is exactly 2', () => {
    expect(DEPLOY_STUCK_MIN_CONSECUTIVE_FAILURES).toBe(2);
  });

  it('flags as unhealthy if last success is >staleness threshold and 1 failure since', () => {
    const now = new Date('2026-04-13T00:00:00Z');
    const result = evaluateDeployStatus(
      [
        run({ id: 1, conclusion: 'failure', createdAt: '2026-04-12T23:00:00Z' }),
        run({ id: 2, conclusion: 'success', createdAt: '2026-04-12T15:00:00Z' }),
      ],
      now,
    );
    expect(result.healthy).toBe(false);
    expect(result.reason).toMatch(/h ago/);
    const ageHours = (now.getTime() - new Date('2026-04-12T15:00:00Z').getTime()) / 3_600_000;
    expect(ageHours).toBeGreaterThan(DEPLOY_STALE_THRESHOLD_HOURS);
  });

  it('does not flag staleness when no failures observed', () => {
    const now = new Date('2026-04-13T00:00:00Z');
    const result = evaluateDeployStatus(
      [run({ id: 1, conclusion: 'success', createdAt: '2026-04-12T15:00:00Z' })],
      now,
    );
    expect(result.healthy).toBe(true);
  });

  it('ignores non-failure conclusions (cancelled, skipped) for streak counting', () => {
    const result = evaluateDeployStatus([
      run({ id: 1, conclusion: 'cancelled', createdAt: '2026-04-12T06:00:00Z' }),
      run({ id: 2, conclusion: 'failure', createdAt: '2026-04-12T05:00:00Z' }),
      run({ id: 3, conclusion: 'failure', createdAt: '2026-04-12T04:00:00Z' }),
      run({ id: 4, conclusion: 'success', createdAt: '2026-04-12T03:00:00Z' }),
    ]);
    expect(result.healthy).toBe(true);
    expect(result.failingDeploys).toHaveLength(0);
  });

  it('historical fixture: the 2026-04-11→12 incident — would flag after deploy #4167 failed', () => {
    const result = evaluateDeployStatus([
      run({
        id: 4180,
        conclusion: 'failure',
        createdAt: '2026-04-12T06:01:21Z',
        displayTitle: 'Merge pull request #4180',
        htmlUrl: 'https://github.com/quantified-uncertainty/longterm-wiki/actions/runs/4180',
      }),
      run({
        id: 4167,
        conclusion: 'failure',
        createdAt: '2026-04-11T22:57:41Z',
        displayTitle: 'Merge pull request #4167',
      }),
      run({
        id: 4148,
        conclusion: 'success',
        createdAt: '2026-04-11T18:29:07Z',
      }),
    ]);
    expect(result.healthy).toBe(false);
    expect(result.reason).toContain('2 consecutive');
    expect(result.failingDeploys[0].htmlUrl).toContain('4180');
    expect(result.lastSuccessfulDeployAt?.toISOString()).toBe('2026-04-11T18:29:07.000Z');
  });
});

// ── evaluateMainCi ───────────────────────────────────────────────────────────

describe('evaluateMainCi', () => {
  it('returns healthy on an empty list', () => {
    const result = evaluateMainCi([]);
    expect(result.healthy).toBe(true);
    expect(result.failingCount).toBe(0);
  });

  it('returns healthy when the latest resolved commit is success', () => {
    const result = evaluateMainCi([
      commit({ sha: 'a', conclusion: 'success' }),
      commit({ sha: 'b', conclusion: 'failure' }),
    ]);
    expect(result.healthy).toBe(true);
    expect(result.failingCount).toBe(0);
  });

  it('skips pending commits at the head and evaluates resolved ones', () => {
    const result = evaluateMainCi([
      commit({ sha: 'pending', conclusion: 'pending' }),
      commit({ sha: 'a', conclusion: 'failure' }),
      commit({ sha: 'b', conclusion: 'failure' }),
      commit({ sha: 'c', conclusion: 'failure' }),
    ]);
    expect(result.healthy).toBe(false);
    expect(result.failingCount).toBe(3);
  });

  it('treats a 2-failure streak as healthy (below ≥3 threshold — flap)', () => {
    const result = evaluateMainCi([
      commit({ sha: 'a', conclusion: 'failure' }),
      commit({ sha: 'b', conclusion: 'failure' }),
      commit({ sha: 'c', conclusion: 'success' }),
    ]);
    expect(result.healthy).toBe(true);
    expect(result.failingCount).toBe(2);
    expect(result.reason).toMatch(/flap/);
  });

  it('flags main-ci-red on a 3-failure streak', () => {
    const result = evaluateMainCi([
      commit({ sha: 'a', conclusion: 'failure', createdAt: '2026-04-12T06:00:00Z' }),
      commit({ sha: 'b', conclusion: 'failure', createdAt: '2026-04-12T05:00:00Z' }),
      commit({
        sha: 'c',
        conclusion: 'failure',
        createdAt: '2026-04-12T04:00:00Z',
      }),
      commit({ sha: 'd', conclusion: 'success', createdAt: '2026-04-12T03:00:00Z' }),
    ]);
    expect(result.healthy).toBe(false);
    expect(result.failingCount).toBe(3);
    expect(result.redStreakStarted?.toISOString()).toBe('2026-04-12T04:00:00.000Z');
    expect(result.reason).toContain('3 consecutive');
  });

  it('validates the red-streak threshold is exactly 3', () => {
    expect(MAIN_CI_RED_STREAK_MIN).toBe(3);
  });

  it('does not fire for failures interrupted by a success', () => {
    const result = evaluateMainCi([
      commit({ sha: 'a', conclusion: 'failure' }),
      commit({ sha: 'b', conclusion: 'success' }),
      commit({ sha: 'c', conclusion: 'failure' }),
      commit({ sha: 'd', conclusion: 'failure' }),
      commit({ sha: 'e', conclusion: 'failure' }),
    ]);
    expect(result.healthy).toBe(true);
    expect(result.failingCount).toBe(1);
  });
});

// ── combineHealth ────────────────────────────────────────────────────────────

describe('combineHealth', () => {
  const now = new Date('2026-04-12T07:00:00Z');

  it('returns healthy with empty issues when both sub-scanners are healthy', () => {
    const deploy = evaluateDeployStatus([run({ conclusion: 'success' })]);
    const mainCi = evaluateMainCi([commit({ conclusion: 'success' })]);
    const combined = combineHealth(deploy, mainCi, now);
    expect(combined.healthy).toBe(true);
    expect(combined.issues).toHaveLength(0);
  });

  it('emits a deploy-stuck issue with correct score + failing url', () => {
    const deploy = evaluateDeployStatus([
      run({ id: 1, conclusion: 'failure', htmlUrl: 'https://example.com/1' }),
      run({ id: 2, conclusion: 'failure' }),
    ]);
    const mainCi = evaluateMainCi([commit({ conclusion: 'success' })]);
    const combined = combineHealth(deploy, mainCi, now);
    expect(combined.healthy).toBe(false);
    expect(combined.issues).toHaveLength(1);
    expect(combined.issues[0].type).toBe('deploy-stuck');
    expect(combined.issues[0].score).toBe(DEPLOY_STUCK_SCORE);
    expect(combined.issues[0].url).toBe('https://example.com/1');
    expect(combined.issues[0].detectedAt).toBe(now.toISOString());
  });

  it('emits a main-ci-red issue with correct score + commit url', () => {
    const deploy = evaluateDeployStatus([run({ conclusion: 'success' })]);
    const mainCi = evaluateMainCi([
      commit({ sha: 'a', conclusion: 'failure', url: 'https://example.com/commit/a' }),
      commit({ sha: 'b', conclusion: 'failure' }),
      commit({ sha: 'c', conclusion: 'failure' }),
    ]);
    const combined = combineHealth(deploy, mainCi, now);
    expect(combined.healthy).toBe(false);
    expect(combined.issues).toHaveLength(1);
    expect(combined.issues[0].type).toBe('main-ci-red');
    expect(combined.issues[0].score).toBe(MAIN_CI_RED_SCORE);
    expect(combined.issues[0].url).toBe('https://example.com/commit/a');
  });

  it('emits both issues with deploy-stuck scored above main-ci-red', () => {
    const deploy = evaluateDeployStatus([
      run({ id: 1, conclusion: 'failure' }),
      run({ id: 2, conclusion: 'failure' }),
    ]);
    const mainCi = evaluateMainCi([
      commit({ sha: 'a', conclusion: 'failure' }),
      commit({ sha: 'b', conclusion: 'failure' }),
      commit({ sha: 'c', conclusion: 'failure' }),
    ]);
    const combined = combineHealth(deploy, mainCi, now);
    expect(combined.issues).toHaveLength(2);
    expect(combined.issues[0].type).toBe('deploy-stuck');
    expect(combined.issues[1].type).toBe('main-ci-red');
    expect(combined.issues[0].score).toBeGreaterThan(combined.issues[1].score);
  });

  it('both issue scores outrank the highest per-PR issue score (conflict=100)', () => {
    expect(DEPLOY_STUCK_SCORE).toBeGreaterThan(100);
    expect(MAIN_CI_RED_SCORE).toBeGreaterThan(100);
  });
});

// ── Regression: leading in-progress deploy does not hide failing streak ─────

describe('evaluateDeployStatus — in-progress at head', () => {
  it('skips a leading null-conclusion run and still sees the failing streak under it', () => {
    const result = evaluateDeployStatus([
      run({ id: 9, conclusion: null, status: 'in_progress', createdAt: '2026-04-12T07:00:00Z' }),
      run({ id: 1, conclusion: 'failure', createdAt: '2026-04-12T06:01:00Z' }),
      run({ id: 2, conclusion: 'failure', createdAt: '2026-04-11T22:57:00Z' }),
      run({ id: 3, conclusion: 'success', createdAt: '2026-04-11T18:29:00Z' }),
    ]);
    expect(result.healthy).toBe(false);
    expect(result.failingDeploys.map((r) => r.id)).toEqual([1, 2]);
  });

  it('treats all-pending as healthy (nothing resolved yet)', () => {
    const result = evaluateDeployStatus([
      run({ id: 1, conclusion: null, status: 'in_progress' }),
      run({ id: 2, conclusion: null, status: 'queued' }),
    ]);
    expect(result.healthy).toBe(true);
  });
});

// ── Regression: pending mid-list does not collapse into fake streak ─────────

describe('evaluateMainCi — mid-list pending interruption', () => {
  it('does NOT collapse [fail, pending, fail, fail] into a 3-streak', () => {
    // Pre-fix this returned streak=3. Post-fix: only LEADING pending is skipped;
    // a pending mid-list breaks the streak the same way a success would.
    const result = evaluateMainCi([
      commit({ sha: 'a', conclusion: 'failure' }),
      commit({ sha: 'b', conclusion: 'pending' }),
      commit({ sha: 'c', conclusion: 'failure' }),
      commit({ sha: 'd', conclusion: 'failure' }),
    ]);
    expect(result.healthy).toBe(true);
    expect(result.failingCount).toBe(1);
  });

  it('skips only the leading pending when it precedes a 3-failure streak', () => {
    const result = evaluateMainCi([
      commit({ sha: 'pending', conclusion: 'pending' }),
      commit({ sha: 'a', conclusion: 'failure', createdAt: '2026-04-12T06:00:00Z' }),
      commit({ sha: 'b', conclusion: 'failure' }),
      commit({ sha: 'c', conclusion: 'failure', createdAt: '2026-04-12T04:00:00Z' }),
    ]);
    expect(result.healthy).toBe(false);
    expect(result.failingCount).toBe(3);
  });

  it('treats null conclusion the same as pending at the head', () => {
    const result = evaluateMainCi([
      commit({ sha: 'unknown', conclusion: null }),
      commit({ sha: 'a', conclusion: 'failure' }),
      commit({ sha: 'b', conclusion: 'failure' }),
      commit({ sha: 'c', conclusion: 'failure' }),
    ]);
    expect(result.healthy).toBe(false);
    expect(result.failingCount).toBe(3);
  });

  it('treats a neutral conclusion as not-failure (breaks streak)', () => {
    const result = evaluateMainCi([
      commit({ sha: 'a', conclusion: 'failure' }),
      commit({ sha: 'b', conclusion: 'neutral' }),
      commit({ sha: 'c', conclusion: 'failure' }),
      commit({ sha: 'd', conclusion: 'failure' }),
    ]);
    expect(result.healthy).toBe(true);
    expect(result.failingCount).toBe(1);
  });
});

// ── mapRollupState — GraphQL enum coverage ──────────────────────────────────

describe('mapRollupState', () => {
  it('maps SUCCESS → success', () => {
    expect(mapRollupState('SUCCESS')).toBe('success');
  });
  it('maps FAILURE and ERROR → failure', () => {
    expect(mapRollupState('FAILURE')).toBe('failure');
    expect(mapRollupState('ERROR')).toBe('failure');
  });
  it('maps PENDING and EXPECTED → pending', () => {
    expect(mapRollupState('PENDING')).toBe('pending');
    expect(mapRollupState('EXPECTED')).toBe('pending');
  });
  it('maps NEUTRAL → neutral (not dropped to null)', () => {
    expect(mapRollupState('NEUTRAL')).toBe('neutral');
  });
  it('maps null → null', () => {
    expect(mapRollupState(null)).toBeNull();
  });
});
