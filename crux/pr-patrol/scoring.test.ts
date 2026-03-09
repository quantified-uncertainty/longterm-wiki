import { describe, it, expect, vi, afterEach } from 'vitest';
import { computeScore, computeBudget, rankPrs, APPROVED_BONUS } from './scoring.ts';
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
    ];
    for (const issue of issueTypes) {
      const pr = makeDetectedPr({ issues: [issue] });
      expect(computeScore(pr)).toBeGreaterThan(0);
    }
  });
});

// ── computeBudget ────────────────────────────────────────────────────────────

describe('computeBudget', () => {
  it('gives small budget for missing-issue-ref only', () => {
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

  it('gives full budget for conflict', () => {
    const budget = computeBudget(['conflict']);
    expect(budget.maxTurns).toBe(60);
    expect(budget.timeoutMinutes).toBe(60);
  });

  it('uses highest budget when multiple issues present', () => {
    const budget = computeBudget(['missing-issue-ref', 'ci-failure']);
    expect(budget.maxTurns).toBe(50);
    expect(budget.timeoutMinutes).toBe(45);
  });

  it('conflict dominates when mixed with smaller issues', () => {
    const budget = computeBudget(['missing-testplan', 'conflict', 'missing-issue-ref']);
    expect(budget.maxTurns).toBe(60);
    expect(budget.timeoutMinutes).toBe(60);
  });

  it('gives medium budget for bot-review-major', () => {
    const budget = computeBudget(['bot-review-major']);
    expect(budget.maxTurns).toBe(50);
    expect(budget.timeoutMinutes).toBe(45);
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
