import { describe, it, expect, vi, afterEach } from 'vitest';
import { computeScore, computeBudget, rankPrs, APPROVED_BONUS, getRetryBudgetMultiplier, computeEffectiveBudget } from './scoring.ts';
import type { DetectedPr, PrIssueType } from './types.ts';

function makeDetectedPr(overrides: Partial<DetectedPr> = {}): DetectedPr {
  return {
    number: 1,
    title: 'Test PR',
    branch: 'claude/test',
    createdAt: new Date().toISOString(),
    issues: [],
    botComments: [],
    labels: [],
    ...overrides,
  };
}

// ── computeScore ─────────────────────────────────────────────────────────────

describe('computeScore', () => {
  it('returns 0 for PR with no issues and zero age', () => {
    const pr = makeDetectedPr({ createdAt: new Date().toISOString() });
    expect(computeScore(pr)).toBe(0);
  });

  it('sums issue scores correctly', () => {
    const pr = makeDetectedPr({ issues: ['conflict', 'ci-failure'] });
    // conflict=100, ci-failure=80, plus age bonus
    const score = computeScore(pr);
    expect(score).toBeGreaterThanOrEqual(180);
  });

  it('adds age bonus of 1 point per hour, capped at 50', () => {
    // 10 hours old
    const tenHoursAgo = new Date(Date.now() - 10 * 3600 * 1000).toISOString();
    const pr10h = makeDetectedPr({ createdAt: tenHoursAgo });
    expect(computeScore(pr10h)).toBe(10);

    // 100 hours old — capped at 50
    const hundredHoursAgo = new Date(Date.now() - 100 * 3600 * 1000).toISOString();
    const pr100h = makeDetectedPr({ createdAt: hundredHoursAgo });
    expect(computeScore(pr100h)).toBe(50);
  });

  it('does not give negative age bonus for future dates', () => {
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    const pr = makeDetectedPr({ createdAt: future });
    expect(computeScore(pr)).toBe(0);
  });

  it('adds approved bonus for stage:approved PRs', () => {
    const pr = makeDetectedPr({ issues: ['conflict'], labels: ['stage:approved'] });
    const prNoLabel = makeDetectedPr({ issues: ['conflict'] });
    expect(computeScore(pr) - computeScore(prNoLabel)).toBe(APPROVED_BONUS);
  });

  it('scores each issue type', () => {
    const issueTypes: PrIssueType[] = [
      'conflict', 'ci-failure', 'bot-review-major',
      'missing-issue-ref', 'stale', 'missing-testplan', 'bot-review-nitpick',
      'merge-blocked', 'self-authored-feedback',
    ];
    for (const issue of issueTypes) {
      const pr = makeDetectedPr({ issues: [issue] });
      expect(computeScore(pr)).toBeGreaterThan(0);
    }
  });

  it('self-authored-feedback scores above merge-blocked and bot-review-major', () => {
    const selfAuthored = makeDetectedPr({ issues: ['self-authored-feedback'] });
    const mergeBlocked = makeDetectedPr({ issues: ['merge-blocked'] });
    const botMajor = makeDetectedPr({ issues: ['bot-review-major'] });
    expect(computeScore(selfAuthored)).toBeGreaterThan(computeScore(mergeBlocked));
    expect(computeScore(selfAuthored)).toBeGreaterThan(computeScore(botMajor));
  });

  it('merge-blocked scores above bot-review-major but below ci-failure', () => {
    const mergeBlocked = makeDetectedPr({ issues: ['merge-blocked'] });
    const botMajor = makeDetectedPr({ issues: ['bot-review-major'] });
    const ciFailure = makeDetectedPr({ issues: ['ci-failure'] });
    expect(computeScore(mergeBlocked)).toBeGreaterThan(computeScore(botMajor));
    expect(computeScore(ciFailure)).toBeGreaterThan(computeScore(mergeBlocked));
  });

  it('stuck scores at 85 (above ci-failure, below self-authored-feedback) — QUA-286', () => {
    const stuck = makeDetectedPr({ issues: ['stuck'] });
    const ciFailure = makeDetectedPr({ issues: ['ci-failure'] });
    const selfAuthored = makeDetectedPr({ issues: ['self-authored-feedback'] });
    expect(computeScore(stuck)).toBeGreaterThan(computeScore(ciFailure));
    expect(computeScore(selfAuthored)).toBeGreaterThan(computeScore(stuck));
  });
});

// ── computeBudget ────────────────────────────────────────────────────────────

describe('computeBudget', () => {
  it('returns default budget for advisory-only issue (missing-issue-ref)', () => {
    // missing-issue-ref is advisory-only and has no budget entry;
    // computeBudget returns the default minimum budget
    const budget = computeBudget(['missing-issue-ref']);
    expect(budget.maxTurns).toBe(5);
    expect(budget.timeoutMinutes).toBe(3);
  });

  it('gives small budget for missing-testplan only', () => {
    const budget = computeBudget(['missing-testplan']);
    expect(budget.maxTurns).toBe(8);
    expect(budget.timeoutMinutes).toBe(5);
  });

  it('gives medium budget for ci-failure', () => {
    const budget = computeBudget(['ci-failure']);
    expect(budget.maxTurns).toBe(50);
    expect(budget.timeoutMinutes).toBe(45);
  });

  it('gives reduced budget for conflict (#3776)', () => {
    const budget = computeBudget(['conflict']);
    expect(budget.maxTurns).toBe(30);
    expect(budget.timeoutMinutes).toBe(20);
  });

  it('uses highest budget when multiple issues present', () => {
    const budget = computeBudget(['missing-issue-ref', 'ci-failure']);
    expect(budget.maxTurns).toBe(50);
    expect(budget.timeoutMinutes).toBe(45);
  });

  it('conflict dominates when mixed with smaller issues', () => {
    const budget = computeBudget(['missing-testplan', 'conflict', 'missing-issue-ref']);
    expect(budget.maxTurns).toBe(30);
    expect(budget.timeoutMinutes).toBe(20);
  });

  it('gives small budget for bot-review-major (#3827)', () => {
    const budget = computeBudget(['bot-review-major']);
    expect(budget.maxTurns).toBe(10);
    expect(budget.timeoutMinutes).toBe(5);
  });

  it('gives small budget for bot-review-nitpick', () => {
    const budget = computeBudget(['bot-review-nitpick']);
    expect(budget.maxTurns).toBe(8);
    expect(budget.timeoutMinutes).toBe(5);
  });

  it('gives stale budget', () => {
    const budget = computeBudget(['stale']);
    expect(budget.maxTurns).toBe(10);
    expect(budget.timeoutMinutes).toBe(5);
  });

  it('gives merge-blocked budget', () => {
    const budget = computeBudget(['merge-blocked']);
    expect(budget.maxTurns).toBe(10);
    expect(budget.timeoutMinutes).toBe(5);
  });

  it('gives self-authored-feedback budget', () => {
    const budget = computeBudget(['self-authored-feedback']);
    expect(budget.maxTurns).toBe(20);
    expect(budget.timeoutMinutes).toBe(15);
  });

  it('gives tiny safety-net budget for stuck — stuck PRs are intercepted before Claude dispatch (QUA-286)', () => {
    // Stuck is intercepted in fixPr() before any Claude dispatch, so the
    // budget here only matters as a defense-in-depth safety net. The entry
    // in ISSUE_BUDGETS is 3/2 but computeBudget() floors to the default
    // minimum of 5/3, which is still tiny compared to other issue types.
    const budget = computeBudget(['stuck']);
    expect(budget.maxTurns).toBeLessThanOrEqual(5);
    expect(budget.timeoutMinutes).toBeLessThanOrEqual(3);
  });
});

// ── getRetryBudgetMultiplier ─────────────────────────────────────────────────

describe('getRetryBudgetMultiplier', () => {
  it('returns 1.0 on first attempt (no prior failures)', () => {
    expect(getRetryBudgetMultiplier(0)).toBe(1.0);
  });

  it('returns 0.5 on second attempt (1 prior failure)', () => {
    expect(getRetryBudgetMultiplier(1)).toBe(0.5);
  });

  it('returns 0.5 on third attempt (2 prior failures)', () => {
    expect(getRetryBudgetMultiplier(2)).toBe(0.5);
  });
});

// ── computeEffectiveBudget ──────────────────────────────────────────────────

describe('computeEffectiveBudget', () => {
  it('returns full budget on first attempt', () => {
    const budget = computeEffectiveBudget(['ci-failure'], 60, 60, 0);
    expect(budget.maxTurns).toBe(50); // ci-failure base is 50, config cap 60
    expect(budget.timeoutMinutes).toBe(45); // ci-failure base is 45, config cap 60
  });

  it('returns half budget on retry', () => {
    const budget = computeEffectiveBudget(['ci-failure'], 60, 60, 1);
    expect(budget.maxTurns).toBe(25); // ceil(50 * 0.5)
    expect(budget.timeoutMinutes).toBe(23); // ceil(45 * 0.5)
  });

  it('applies config cap before multiplier', () => {
    // Config caps at 30 turns / 20 min, ci-failure base is 50/45
    const first = computeEffectiveBudget(['ci-failure'], 30, 20, 0);
    expect(first.maxTurns).toBe(30);
    expect(first.timeoutMinutes).toBe(20);

    const retry = computeEffectiveBudget(['ci-failure'], 30, 20, 1);
    expect(retry.maxTurns).toBe(15); // ceil(30 * 0.5)
    expect(retry.timeoutMinutes).toBe(10); // ceil(20 * 0.5)
  });

  it('uses Math.ceil so budget never rounds down to 0', () => {
    // missing-issue-ref has 5 turns / 3 min — half should be 3 / 2, not 2 / 1
    const budget = computeEffectiveBudget(['missing-issue-ref'], 60, 60, 1);
    expect(budget.maxTurns).toBe(3); // ceil(5 * 0.5) = 3
    expect(budget.timeoutMinutes).toBe(2); // ceil(3 * 0.5) = 2
  });

  it('conflict issue gets 30 turns on first attempt, 15 on retry (#3776)', () => {
    const first = computeEffectiveBudget(['conflict'], 60, 60, 0);
    expect(first.maxTurns).toBe(30);
    expect(first.timeoutMinutes).toBe(20);

    const retry = computeEffectiveBudget(['conflict'], 60, 60, 1);
    expect(retry.maxTurns).toBe(15);
    expect(retry.timeoutMinutes).toBe(10);
  });
});

// ── rankPrs ──────────────────────────────────────────────────────────────────

describe('rankPrs', () => {
  it('sorts by score descending', () => {
    const prs = [
      makeDetectedPr({ number: 1, issues: ['missing-testplan'] }),
      makeDetectedPr({ number: 2, issues: ['conflict'] }),
      makeDetectedPr({ number: 3, issues: ['ci-failure'] }),
    ];
    const ranked = rankPrs(prs);
    expect(ranked[0].number).toBe(2); // conflict=100
    expect(ranked[1].number).toBe(3); // ci-failure=80
    expect(ranked[2].number).toBe(1); // missing-testplan=20
  });

  it('prioritizes approved PRs with simple issues over unapproved PRs with complex issues', () => {
    const prs = [
      makeDetectedPr({ number: 1, issues: ['ci-failure', 'bot-review-major'] }), // 135 + age
      makeDetectedPr({ number: 2, issues: ['conflict'], labels: ['stage:approved'] }), // 100 + 100 + age
    ];
    const ranked = rankPrs(prs);
    expect(ranked[0].number).toBe(2); // approved conflict beats unapproved ci-failure+bot-review
  });

  it('returns empty array for empty input', () => {
    expect(rankPrs([])).toEqual([]);
  });

  it('attaches score to each PR', () => {
    const prs = [makeDetectedPr({ number: 1, issues: ['conflict'] })];
    const ranked = rankPrs(prs);
    expect(ranked[0].score).toBeGreaterThanOrEqual(100);
  });
});
