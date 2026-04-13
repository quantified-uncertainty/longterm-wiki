import { describe, it, expect } from 'vitest';

import {
  evaluateDeployStatus,
  evaluateMainCi,
  evaluateRatchetDrift,
  combineHealth,
  combineRatchetDrift,
  checkRatchetDriftForFile,
  readBaselineTotal,
  mapRollupState,
  DEPLOY_STUCK_MIN_CONSECUTIVE_FAILURES,
  MAIN_CI_RED_STREAK_MIN,
  DEPLOY_STALE_THRESHOLD_HOURS,
  DEPLOY_STUCK_SCORE,
  MAIN_CI_RED_SCORE,
  RATCHET_DRIFT_SCORE,
  RATCHET_DRIFT_MIN_BUMPS,
  RATCHET_DRIFT_WINDOW_HOURS,
  type WorkflowRun,
  type CommitStatus,
  type BaselineObservation,
  type RatchetDriftResult,
} from './health-scan.ts';
import type { RatchetConfig } from './ratchet-config.ts';

function emptyRatchet(): RatchetDriftResult {
  return combineRatchetDrift([]);
}

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
    const combined = combineHealth(deploy, mainCi, emptyRatchet(), now);
    expect(combined.healthy).toBe(true);
    expect(combined.issues).toHaveLength(0);
  });

  it('emits a deploy-stuck issue with correct score + failing url', () => {
    const deploy = evaluateDeployStatus([
      run({ id: 1, conclusion: 'failure', htmlUrl: 'https://example.com/1' }),
      run({ id: 2, conclusion: 'failure' }),
    ]);
    const mainCi = evaluateMainCi([commit({ conclusion: 'success' })]);
    const combined = combineHealth(deploy, mainCi, emptyRatchet(), now);
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
    const combined = combineHealth(deploy, mainCi, emptyRatchet(), now);
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
    const combined = combineHealth(deploy, mainCi, emptyRatchet(), now);
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

// ── evaluateRatchetDrift (pure) ──────────────────────────────────────────────

describe('evaluateRatchetDrift', () => {
  const NOW = new Date('2026-04-12T20:00:00Z');

  function obs(hoursAgo: number, total: number | null, commit = `c${hoursAgo}`): BaselineObservation {
    return {
      commit,
      committedAt: new Date(NOW.getTime() - hoursAgo * 3_600_000),
      total,
    };
  }

  it('fires on 3 monotonic upward bumps within 24h (bad direction = up)', () => {
    const result = evaluateRatchetDrift(
      'sourcing.json',
      'sourcing',
      [obs(10, 2), obs(8, 5), obs(5, 10), obs(1, 23)],
      { badDirection: 'up', now: NOW },
    );
    expect(result.drifted).toBe(true);
    expect(result.bumpCount).toBe(3);
    expect(result.direction).toBe('up');
    expect(result.bumps.map((b) => [b.from, b.to])).toEqual([
      [2, 5],
      [5, 10],
      [10, 23],
    ]);
  });

  it('does NOT fire with only 2 bumps in window (below threshold of 3)', () => {
    const result = evaluateRatchetDrift(
      'sourcing.json',
      'sourcing',
      [obs(10, 2), obs(5, 10), obs(1, 23)],
      { badDirection: 'up', now: NOW },
    );
    expect(result.drifted).toBe(false);
    expect(result.bumpCount).toBe(2);
  });

  it('does NOT fire when 3 bumps span a 48h window (rate-limited)', () => {
    // 3 bumps, but spread across 48h — only the last one is in the 24h window.
    const result = evaluateRatchetDrift(
      'sourcing.json',
      'sourcing',
      [obs(48, 2), obs(36, 5), obs(30, 10), obs(1, 23)],
      { badDirection: 'up', now: NOW, windowHours: 24 },
    );
    expect(result.drifted).toBe(false);
    // Only the 30h→1h transition is seen as a bump in the windowed view,
    // because the pre-window parent observation was filtered out.
    expect(result.bumpCount).toBeLessThan(3);
  });

  it('does NOT fire on alternating-direction bumps', () => {
    const result = evaluateRatchetDrift(
      'sourcing.json',
      'sourcing',
      [obs(10, 5), obs(8, 20), obs(5, 7), obs(1, 30)],
      { badDirection: 'up', now: NOW },
    );
    // Sequence: 5→20 (up), 20→7 (down, reset), 7→30 (up) → bad-direction streak=1
    expect(result.drifted).toBe(false);
    expect(result.bumpCount).toBe(1);
  });

  it('resets the streak when a good-direction bump interrupts (fix landed mid-window)', () => {
    const result = evaluateRatchetDrift(
      'sourcing.json',
      'sourcing',
      [obs(10, 2), obs(8, 5), obs(6, 10), obs(4, 4), obs(2, 8)],
      { badDirection: 'up', now: NOW },
    );
    // 2→5 up, 5→10 up (streak=2), 10→4 DOWN (reset), 4→8 up (streak=1)
    expect(result.drifted).toBe(false);
    expect(result.bumpCount).toBe(1);
  });

  it('ignores no-op commits (total unchanged) without counting them as bumps', () => {
    const result = evaluateRatchetDrift(
      'sourcing.json',
      'sourcing',
      [obs(10, 2), obs(8, 2), obs(6, 5), obs(4, 5), obs(2, 10), obs(1, 23)],
      { badDirection: 'up', now: NOW },
    );
    expect(result.drifted).toBe(true);
    expect(result.bumpCount).toBe(3); // 2→5, 5→10, 10→23
  });

  it('skips observations with null total (file absent at that commit)', () => {
    const result = evaluateRatchetDrift(
      'sourcing.json',
      'sourcing',
      [obs(10, null), obs(8, 2), obs(5, 5), obs(3, 10), obs(1, 23)],
      { badDirection: 'up', now: NOW },
    );
    expect(result.drifted).toBe(true);
    expect(result.bumpCount).toBe(3);
  });

  it('validates constants', () => {
    expect(RATCHET_DRIFT_MIN_BUMPS).toBe(3);
    expect(RATCHET_DRIFT_WINDOW_HOURS).toBe(24);
  });

  it('fires on 3 downward bumps when bad direction = down (e.g., coverage ratchet)', () => {
    const result = evaluateRatchetDrift(
      'coverage.json',
      'coverage',
      [obs(10, 100), obs(8, 95), obs(5, 90), obs(1, 80)],
      { badDirection: 'down', now: NOW },
    );
    expect(result.drifted).toBe(true);
    expect(result.direction).toBe('down');
    expect(result.bumpCount).toBe(3);
    expect(result.reason).toContain('↓');
  });

  it('returns a stable-reason for empty observations', () => {
    const result = evaluateRatchetDrift('x.json', 'x', [], {
      badDirection: 'up',
      now: NOW,
    });
    expect(result.drifted).toBe(false);
    expect(result.bumpCount).toBe(0);
    expect(result.reason).toContain('stable');
  });
});

// ── combineRatchetDrift ──────────────────────────────────────────────────────

describe('combineRatchetDrift', () => {
  it('is healthy when no ratchets are registered', () => {
    const result = combineRatchetDrift([]);
    expect(result.healthy).toBe(true);
    expect(result.reason).toContain('no ratchet');
  });

  it('is healthy when all registered ratchets are within thresholds', () => {
    const result = combineRatchetDrift([
      {
        file: 'a.json',
        name: 'a',
        direction: null,
        bumpCount: 0,
        bumps: [],
        drifted: false,
        reason: 'ok',
      },
    ]);
    expect(result.healthy).toBe(true);
  });

  it('is unhealthy when any ratchet drifted', () => {
    const result = combineRatchetDrift([
      {
        file: 'a.json',
        name: 'a',
        direction: 'up',
        bumpCount: 3,
        bumps: [],
        drifted: true,
        reason: 'a bumped 3×',
      },
      {
        file: 'b.json',
        name: 'b',
        direction: null,
        bumpCount: 0,
        bumps: [],
        drifted: false,
        reason: 'ok',
      },
    ]);
    expect(result.healthy).toBe(false);
    expect(result.reason).toBe('a bumped 3×');
  });
});

// ── combineHealth + ratchet integration ──────────────────────────────────────

describe('combineHealth with ratchet drift', () => {
  const now = new Date('2026-04-12T07:00:00Z');

  it('emits a ratchet-drift issue when a baseline drifted', () => {
    const deploy = evaluateDeployStatus([run({ conclusion: 'success' })]);
    const mainCi = evaluateMainCi([commit({ conclusion: 'success' })]);
    const ratchet: RatchetDriftResult = {
      healthy: false,
      reason: 'sourcing bumped 3× ↑',
      drifts: [
        {
          file: 'sourcing.json',
          name: 'sourcing',
          direction: 'up',
          bumpCount: 3,
          bumps: [],
          drifted: true,
          reason: 'sourcing bumped 3× ↑',
        },
      ],
    };
    const combined = combineHealth(deploy, mainCi, ratchet, now);
    expect(combined.healthy).toBe(false);
    expect(combined.issues).toHaveLength(1);
    expect(combined.issues[0].type).toBe('ratchet-drift');
    expect(combined.issues[0].score).toBe(RATCHET_DRIFT_SCORE);
    expect(combined.issues[0].reason).toBe('sourcing bumped 3× ↑');
  });

  // ── QUA-309: structured fingerprintKey ──────────────────────────────────────

  it('populates fingerprintKey on ratchet-drift issues from drift.name', () => {
    const deploy = evaluateDeployStatus([run({ conclusion: 'success' })]);
    const mainCi = evaluateMainCi([commit({ conclusion: 'success' })]);
    const ratchet: RatchetDriftResult = {
      healthy: false,
      reason: 'two files drifted',
      drifts: [
        {
          file: 'sourcing.json',
          name: 'sourcing',
          direction: 'up',
          bumpCount: 3,
          bumps: [],
          drifted: true,
          reason: 'sourcing bumped 3× ↑',
        },
        {
          file: 'review-marker.json',
          name: 'review-marker',
          direction: 'up',
          bumpCount: 3,
          bumps: [],
          drifted: true,
          reason: 'review-marker bumped 3× ↑',
        },
      ],
    };
    const combined = combineHealth(deploy, mainCi, ratchet, now);
    const driftIssues = combined.issues.filter((i) => i.type === 'ratchet-drift');
    expect(driftIssues).toHaveLength(2);
    expect(driftIssues[0].fingerprintKey).toBe('sourcing');
    expect(driftIssues[1].fingerprintKey).toBe('review-marker');
  });

  it('does not populate fingerprintKey on deploy-stuck or main-ci-red issues', () => {
    const deploy = evaluateDeployStatus([
      run({ id: 1, conclusion: 'failure' }),
      run({ id: 2, conclusion: 'failure' }),
    ]);
    const mainCi = evaluateMainCi([
      commit({ sha: 'a', conclusion: 'failure' }),
      commit({ sha: 'b', conclusion: 'failure' }),
      commit({ sha: 'c', conclusion: 'failure' }),
    ]);
    const combined = combineHealth(deploy, mainCi, emptyRatchet(), now);
    const deployStuck = combined.issues.find((i) => i.type === 'deploy-stuck');
    const mainCiRed = combined.issues.find((i) => i.type === 'main-ci-red');
    expect(deployStuck?.fingerprintKey).toBeUndefined();
    expect(mainCiRed?.fingerprintKey).toBeUndefined();
  });

  it('ranks deploy-stuck > main-ci-red > ratchet-drift', () => {
    expect(DEPLOY_STUCK_SCORE).toBeGreaterThan(MAIN_CI_RED_SCORE);
    expect(MAIN_CI_RED_SCORE).toBeGreaterThan(RATCHET_DRIFT_SCORE);
    // And ratchet-drift still outranks per-PR conflict (100)
    expect(RATCHET_DRIFT_SCORE).toBeGreaterThan(100);
  });

  it('emits all three issues when everything is unhealthy', () => {
    const deploy = evaluateDeployStatus([
      run({ id: 1, conclusion: 'failure' }),
      run({ id: 2, conclusion: 'failure' }),
    ]);
    const mainCi = evaluateMainCi([
      commit({ sha: 'a', conclusion: 'failure' }),
      commit({ sha: 'b', conclusion: 'failure' }),
      commit({ sha: 'c', conclusion: 'failure' }),
    ]);
    const ratchet: RatchetDriftResult = {
      healthy: false,
      reason: 'drift',
      drifts: [
        {
          file: 'x.json',
          name: 'x',
          direction: 'up',
          bumpCount: 3,
          bumps: [],
          drifted: true,
          reason: 'x bumped 3×',
        },
      ],
    };
    const combined = combineHealth(deploy, mainCi, ratchet, now);
    expect(combined.issues.map((i) => i.type)).toEqual([
      'deploy-stuck',
      'main-ci-red',
      'ratchet-drift',
    ]);
    // Issues are pushed in the order they're checked — which is also the
    // priority order. Verify scores are monotonically decreasing.
    const scores = combined.issues.map((i) => i.score);
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[1]).toBeGreaterThan(scores[2]);
  });
});

// ── readBaselineTotal (numeric-type handling) ────────────────────────────────

describe('readBaselineTotal', () => {
  const cfg: RatchetConfig = {
    file: 'x.json',
    name: 'x',
    totalField: 'total',
    badDirection: 'up',
  };

  it('reads a numeric total', () => {
    const runGit = () => ({ ok: true, output: '{"total": 23}', stderr: '' });
    expect(readBaselineTotal('HEAD', cfg, runGit)).toBe(23);
  });

  it('coerces a numeric-string total (regression: validators may serialize as string)', () => {
    const runGit = () => ({ ok: true, output: '{"total": "23"}', stderr: '' });
    expect(readBaselineTotal('HEAD', cfg, runGit)).toBe(23);
  });

  it('returns null for non-numeric string', () => {
    const runGit = () => ({ ok: true, output: '{"total": "pending"}', stderr: '' });
    expect(readBaselineTotal('HEAD', cfg, runGit)).toBeNull();
  });

  it('returns null when the field is missing', () => {
    const runGit = () => ({ ok: true, output: '{"other": 1}', stderr: '' });
    expect(readBaselineTotal('HEAD', cfg, runGit)).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    const runGit = () => ({ ok: true, output: 'not-json', stderr: '' });
    expect(readBaselineTotal('HEAD', cfg, runGit)).toBeNull();
  });

  it('returns null when git show fails (file absent at ref)', () => {
    const runGit = () => ({ ok: false, output: '', stderr: 'fatal: path not in tree' });
    expect(readBaselineTotal('HEAD', cfg, runGit)).toBeNull();
  });

  it('returns null for Infinity / NaN (both JSON and string forms)', () => {
    // JSON doesn't allow Infinity, but the string-coercion branch could hit it.
    const runGit1 = () => ({ ok: true, output: '{"total": "Infinity"}', stderr: '' });
    expect(readBaselineTotal('HEAD', cfg, runGit1)).toBeNull();
    const runGit2 = () => ({ ok: true, output: '{"total": "NaN"}', stderr: '' });
    expect(readBaselineTotal('HEAD', cfg, runGit2)).toBeNull();
  });
});

// ── checkRatchetDriftForFile (I/O wrapper, mocked gitSafe) ───────────────────

describe('checkRatchetDriftForFile (mocked git)', () => {
  const NOW = new Date('2026-04-12T20:00:00Z');
  const cfg: RatchetConfig = {
    file: 'crux/validate/.sourcing-baseline.json',
    name: 'sourcing',
    totalField: 'total',
    badDirection: 'up',
  };

  function makeGit(
    logOutput: string,
    showResponses: Record<string, { ok: boolean; output: string; stderr?: string }> = {},
  ) {
    return (...args: string[]) => {
      if (args[0] === 'log') {
        return { ok: true, output: logOutput, stderr: '' };
      }
      if (args[0] === 'show' && args[1] === '-s') {
        // commitTimestamp: `git show -s --format=%ct <ref>`
        const ref = args[3];
        const resp = showResponses[`ts:${ref}`];
        return resp ?? { ok: false, output: '', stderr: 'not found' };
      }
      if (args[0] === 'show') {
        // readBaselineTotal: `git show <ref>:<file>`
        const spec = args[1];
        const resp = showResponses[spec];
        return resp ?? { ok: false, output: '', stderr: 'not found' };
      }
      return { ok: false, output: '', stderr: 'unexpected git call' };
    };
  }

  function epoch(iso: string): string {
    return String(Math.floor(new Date(iso).getTime() / 1000));
  }

  it('fires when 3 upward bumps appear in the window (file existed before window)', () => {
    const c1 = { iso: '2026-04-12T10:00:00Z' };
    const c2 = { iso: '2026-04-12T14:00:00Z' };
    const c3 = { iso: '2026-04-12T18:00:00Z' };
    // git log newest-first:
    const logOutput = [
      `c3 ${epoch(c3.iso)}`,
      `c2 ${epoch(c2.iso)}`,
      `c1 ${epoch(c1.iso)}`,
    ].join('\n');
    const showResponses = {
      'c1^:crux/validate/.sourcing-baseline.json': {
        ok: true,
        output: '{"total": 2}',
        stderr: '',
      },
      'ts:c1^': { ok: true, output: epoch('2026-04-11T23:00:00Z'), stderr: '' },
      'c1:crux/validate/.sourcing-baseline.json': {
        ok: true,
        output: '{"total": 5}',
        stderr: '',
      },
      'c2:crux/validate/.sourcing-baseline.json': {
        ok: true,
        output: '{"total": 10}',
        stderr: '',
      },
      'c3:crux/validate/.sourcing-baseline.json': {
        ok: true,
        output: '{"total": 23}',
        stderr: '',
      },
    };
    const result = checkRatchetDriftForFile(cfg, { now: NOW }, makeGit(logOutput, showResponses));
    expect(result.drifted).toBe(true);
    expect(result.bumpCount).toBe(3);
    expect(result.bumps.map((b) => [b.from, b.to])).toEqual([
      [2, 5],
      [5, 10],
      [10, 23],
    ]);
  });

  it('handles a file created mid-window (parent-of-first-commit has no file) — 3 later bumps still fire', () => {
    // File is created by c1 at total=2. Parent c1^ doesn't have the file.
    // Subsequent commits c2=5, c3=10, c4=23. The evaluator sees observations
    // [c1=2, c2=5, c3=10, c4=23] — parent is skipped cleanly.
    const logOutput = [
      `c4 ${epoch('2026-04-12T18:00:00Z')}`,
      `c3 ${epoch('2026-04-12T15:00:00Z')}`,
      `c2 ${epoch('2026-04-12T12:00:00Z')}`,
      `c1 ${epoch('2026-04-12T09:00:00Z')}`,
    ].join('\n');
    const showResponses = {
      // Parent of c1 has no file — git show returns non-ok
      'c1^:crux/validate/.sourcing-baseline.json': {
        ok: false,
        output: '',
        stderr: 'fatal: path not in tree',
      },
      'c1:crux/validate/.sourcing-baseline.json': { ok: true, output: '{"total": 2}', stderr: '' },
      'c2:crux/validate/.sourcing-baseline.json': { ok: true, output: '{"total": 5}', stderr: '' },
      'c3:crux/validate/.sourcing-baseline.json': { ok: true, output: '{"total": 10}', stderr: '' },
      'c4:crux/validate/.sourcing-baseline.json': { ok: true, output: '{"total": 23}', stderr: '' },
    };
    const result = checkRatchetDriftForFile(cfg, { now: NOW }, makeGit(logOutput, showResponses));
    expect(result.drifted).toBe(true);
    expect(result.bumpCount).toBe(3);
  });

  it('handles a comment-only commit (touches file but leaves total unchanged)', () => {
    // c1 touches file but keeps total at 5; c2 bumps to 10; c3 bumps to 23.
    // Only c1→c2 (up) and c2→c3 (up) are bumps. Plus parent→c1 (2→5, up) if
    // parent is readable. That gives 3 bumps total.
    const logOutput = [
      `c3 ${epoch('2026-04-12T18:00:00Z')}`,
      `c2 ${epoch('2026-04-12T15:00:00Z')}`,
      `c1 ${epoch('2026-04-12T12:00:00Z')}`,
    ].join('\n');
    const showResponses = {
      'c1^:crux/validate/.sourcing-baseline.json': {
        ok: true,
        output: '{"total": 5}',
        stderr: '',
      },
      'ts:c1^': { ok: true, output: epoch('2026-04-12T09:00:00Z'), stderr: '' },
      // c1 touched the file but didn't change the total
      'c1:crux/validate/.sourcing-baseline.json': { ok: true, output: '{"total": 5}', stderr: '' },
      'c2:crux/validate/.sourcing-baseline.json': { ok: true, output: '{"total": 10}', stderr: '' },
      'c3:crux/validate/.sourcing-baseline.json': { ok: true, output: '{"total": 23}', stderr: '' },
    };
    const result = checkRatchetDriftForFile(cfg, { now: NOW }, makeGit(logOutput, showResponses));
    // Bumps: parent→c1 (5=5, no bump), c1→c2 (5→10 up), c2→c3 (10→23 up) = 2
    expect(result.drifted).toBe(false);
    expect(result.bumpCount).toBe(2);
  });

  it('returns stable+zero-bumps when git log has no commits in the window', () => {
    const runGit = makeGit('');
    const result = checkRatchetDriftForFile(cfg, { now: NOW }, runGit);
    expect(result.drifted).toBe(false);
    expect(result.bumpCount).toBe(0);
    expect(result.reason).toContain('no commits');
  });

  it('throws when git log fails so runHealthGate counts it as a scanner error (not fail-open)', () => {
    const runGit = () => ({ ok: false, output: '', stderr: 'fatal: not a git repository' });
    expect(() => checkRatchetDriftForFile(cfg, { now: NOW }, runGit)).toThrow(
      /git log failed.*not a git repository/,
    );
  });

  it('uses --since=<iso> derived from `now` (not git wall-clock relative date)', () => {
    // Capture the --since arg to verify it matches `now - windowHours`.
    let capturedSince: string | null = null;
    const runGit = (...args: string[]) => {
      if (args[0] === 'log') {
        const sinceArg = args.find((a) => a.startsWith('--since='));
        capturedSince = sinceArg?.replace('--since=', '') ?? null;
        return { ok: true, output: '', stderr: '' };
      }
      return { ok: false, output: '', stderr: '' };
    };
    checkRatchetDriftForFile(cfg, { now: NOW, windowHours: 24 }, runGit);
    expect(capturedSince).toBe(new Date(NOW.getTime() - 24 * 3_600_000).toISOString());
  });
});

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
