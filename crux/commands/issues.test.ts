/**
 * Tests for crux/commands/issues.ts
 *
 * Focus areas:
 * - Input validation (start/done reject bad args)
 * - Priority ranking logic (via list command with mocked GitHub data)
 * - Weighted scoring (scoreIssue helper)
 * - Blocked detection (isBlocked helper + UI separation)
 * - Claude-ready label boost
 * - Score breakdown display (--scores flag)
 * - Edge cases: empty issue list, all issues in-progress, unknown labels
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the github lib before importing the command under test
vi.mock('../lib/github.ts', () => ({
  REPO: 'quantified-uncertainty/longterm-wiki',
  githubApi: vi.fn(),
}));

// Also mock execSync used by currentBranch()
vi.mock('child_process', () => ({
  execSync: vi.fn(() => 'claude/test-branch-ABC'),
}));

import { commands, scoreIssue, isBlocked, findPotentialDuplicates } from './issues.ts';
import * as githubLib from '../lib/github.ts';

const mockGithubApi = vi.mocked(githubLib.githubApi);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(overrides: {
  number?: number;
  title?: string;
  labels?: string[];
  created_at?: string;
  updated_at?: string;
  body?: string | null;
  pull_request?: object;
} = {}) {
  return {
    number: overrides.number ?? 1,
    title: overrides.title ?? 'Test issue',
    body: overrides.body ?? 'Issue body',
    labels: (overrides.labels ?? []).map(name => ({ name })),
    created_at: overrides.created_at ?? '2026-01-01T00:00:00Z',
    updated_at: overrides.updated_at ?? '2026-01-01T00:00:00Z',
    html_url: `https://github.com/test/repo/issues/${overrides.number ?? 1}`,
    ...(overrides.pull_request ? { pull_request: overrides.pull_request } : {}),
  };
}

// ---------------------------------------------------------------------------
// Input validation: start command
// ---------------------------------------------------------------------------

describe('issues start — input validation', () => {
  it('returns usage error when no args provided', async () => {
    const result = await commands.start([], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Usage');
    expect(result.output).toContain('start');
  });

  it('returns usage error when arg is not a number', async () => {
    const result = await commands.start(['not-a-number'], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Usage');
  });

  it('returns usage error for issue number 0', async () => {
    const result = await commands.start(['0'], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Usage');
  });
});

// ---------------------------------------------------------------------------
// Input validation: done command
// ---------------------------------------------------------------------------

describe('issues done — input validation', () => {
  it('returns usage error when no args provided', async () => {
    const result = await commands.done([], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Usage');
    expect(result.output).toContain('done');
  });

  it('returns usage error when arg is not a number', async () => {
    const result = await commands.done(['abc'], {});
    expect(result.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// scoreIssue unit tests
// ---------------------------------------------------------------------------

describe('scoreIssue', () => {
  const OLD_DATE = '2025-01-01T00:00:00Z';  // ~13 months ago
  const RECENT_DATE = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago

  it('P0 scores much higher than P1', () => {
    const p0 = scoreIssue(['P0'], '', OLD_DATE, OLD_DATE);
    const p1 = scoreIssue(['P1'], '', OLD_DATE, OLD_DATE);
    expect(p0.total).toBeGreaterThan(p1.total);
    expect(p0.priority).toBe(1000);
    expect(p1.priority).toBe(500);
  });

  it('P1 > P2 > P3 > unlabeled', () => {
    const p1 = scoreIssue(['P1'], '', OLD_DATE, OLD_DATE).total;
    const p2 = scoreIssue(['P2'], '', OLD_DATE, OLD_DATE).total;
    const p3 = scoreIssue(['P3'], '', OLD_DATE, OLD_DATE).total;
    const none = scoreIssue([], '', OLD_DATE, OLD_DATE).total;
    expect(p1).toBeGreaterThan(p2);
    expect(p2).toBeGreaterThan(p3);
    expect(p3).toBeGreaterThan(none);
  });

  it('bug label adds bonus', () => {
    const withBug = scoreIssue(['bug', 'P2'], '', OLD_DATE, OLD_DATE);
    const withoutBug = scoreIssue(['P2'], '', OLD_DATE, OLD_DATE);
    expect(withBug.bugBonus).toBe(50);
    expect(withBug.total).toBeGreaterThan(withoutBug.total);
  });

  it('claude-ready label adds ~50% bonus', () => {
    const withReady = scoreIssue(['P2', 'claude-ready'], '', OLD_DATE, OLD_DATE);
    const withoutReady = scoreIssue(['P2'], '', OLD_DATE, OLD_DATE);
    expect(withReady.claudeReadyBonus).toBeGreaterThan(0);
    expect(withReady.total).toBeGreaterThan(withoutReady.total);
  });

  it('effort:low adds bonus, effort:high subtracts', () => {
    const low = scoreIssue(['effort:low', 'P2'], '', OLD_DATE, OLD_DATE);
    const high = scoreIssue(['effort:high', 'P2'], '', OLD_DATE, OLD_DATE);
    const neutral = scoreIssue(['P2'], '', OLD_DATE, OLD_DATE);
    expect(low.effortAdjustment).toBe(20);
    expect(high.effortAdjustment).toBe(-20);
    expect(low.total).toBeGreaterThan(neutral.total);
    expect(neutral.total).toBeGreaterThan(high.total);
  });

  it('recency bonus applies when updated within 7 days', () => {
    const recent = scoreIssue([], '', OLD_DATE, RECENT_DATE);
    const old = scoreIssue([], '', OLD_DATE, OLD_DATE);
    expect(recent.recencyBonus).toBe(15);
    expect(old.recencyBonus).toBe(0);
    expect(recent.total).toBeGreaterThan(old.total);
  });

  it('age bonus increases with issue age (capped at 10)', () => {
    const veryOld = scoreIssue([], '', '2020-01-01T00:00:00Z', OLD_DATE);
    const recent = scoreIssue([], '', new Date().toISOString(), new Date().toISOString());
    expect(veryOld.ageBonus).toBe(10); // capped
    expect(recent.ageBonus).toBe(0);
  });

  it('total is sum of all components', () => {
    const bd = scoreIssue(['P1', 'bug'], '', OLD_DATE, OLD_DATE);
    expect(bd.total).toBe(bd.priority + bd.bugBonus + bd.claudeReadyBonus + bd.effortAdjustment + bd.recencyBonus + bd.ageBonus);
  });
});

// ---------------------------------------------------------------------------
// isBlocked unit tests
// ---------------------------------------------------------------------------

describe('isBlocked', () => {
  it('detects blocked label', () => {
    expect(isBlocked(['blocked'], '')).toBe(true);
  });

  it('detects waiting label', () => {
    expect(isBlocked(['waiting'], '')).toBe(true);
  });

  it('detects needs-info label', () => {
    expect(isBlocked(['needs-info'], '')).toBe(true);
  });

  it('detects stalled label', () => {
    expect(isBlocked(['stalled'], '')).toBe(true);
  });

  it('detects "blocked by" in body text', () => {
    expect(isBlocked([], 'This is blocked by issue #42')).toBe(true);
  });

  it('detects "waiting for" in body text', () => {
    expect(isBlocked([], 'Waiting for upstream fix')).toBe(true);
  });

  it('detects "depends on #N" in body text', () => {
    expect(isBlocked([], 'This depends on #123 being merged')).toBe(true);
  });

  it('returns false for normal issues', () => {
    expect(isBlocked(['bug', 'P1'], 'This is a normal bug report')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Priority ranking via list command
// ---------------------------------------------------------------------------

describe('issues list — priority ranking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns CommandResult with output and exitCode=0', async () => {
    mockGithubApi.mockResolvedValueOnce([]);
    const result = await commands.list([], {});
    expect(result).toHaveProperty('output');
    expect(result).toHaveProperty('exitCode', 0);
  });

  it('ranks P0 issues above unlabeled issues', async () => {
    mockGithubApi.mockResolvedValueOnce([
      makeIssue({ number: 10, title: 'Unlabeled issue', labels: [], created_at: '2026-01-01T00:00:00Z' }),
      makeIssue({ number: 20, title: 'P0 urgent issue', labels: ['P0'], created_at: '2026-02-01T00:00:00Z' }),
    ]);
    const result = await commands.list([], {});
    const p0Pos = result.output.indexOf('#20');
    const unlabeledPos = result.output.indexOf('#10');
    expect(p0Pos).toBeGreaterThan(-1);
    expect(unlabeledPos).toBeGreaterThan(-1);
    expect(p0Pos).toBeLessThan(unlabeledPos);
  });

  it('ranks P1 above P2 above P3 above unlabeled', async () => {
    mockGithubApi.mockResolvedValueOnce([
      makeIssue({ number: 3, title: 'P3 issue', labels: ['P3'] }),
      makeIssue({ number: 1, title: 'P1 issue', labels: ['P1'] }),
      makeIssue({ number: 99, title: 'Unlabeled', labels: [] }),
      makeIssue({ number: 2, title: 'P2 issue', labels: ['P2'] }),
    ]);
    const result = await commands.list([], {});
    const pos1 = result.output.indexOf('#1');
    const pos2 = result.output.indexOf('#2');
    const pos3 = result.output.indexOf('#3');
    const pos99 = result.output.indexOf('#99');
    expect(pos1).toBeLessThan(pos2);
    expect(pos2).toBeLessThan(pos3);
    expect(pos3).toBeLessThan(pos99);
  });

  it('within same priority, older issues rank higher', async () => {
    mockGithubApi.mockResolvedValueOnce([
      makeIssue({ number: 5, title: 'Newer P1', labels: ['P1'], created_at: '2026-02-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z' }),
      makeIssue({ number: 3, title: 'Older P1', labels: ['P1'], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }),
    ]);
    const result = await commands.list([], {});
    const pos3 = result.output.indexOf('#3');
    const pos5 = result.output.indexOf('#5');
    expect(pos3).toBeLessThan(pos5);
  });

  it('separates claude-working issues into In Progress section', async () => {
    mockGithubApi.mockResolvedValueOnce([
      makeIssue({ number: 10, title: 'Normal issue', labels: [] }),
      makeIssue({ number: 20, title: 'Active issue', labels: ['claude-working'] }),
    ]);
    const result = await commands.list([], {});
    expect(result.output).toContain('In Progress');
    // claude-working issue should appear before the queue section
    const progressSection = result.output.slice(0, result.output.indexOf('Queue:'));
    expect(progressSection).toContain('#20');
  });

  it('separates blocked issues into Blocked section', async () => {
    mockGithubApi.mockResolvedValueOnce([
      makeIssue({ number: 10, title: 'Normal issue', labels: [] }),
      makeIssue({ number: 30, title: 'Blocked issue', labels: ['blocked'] }),
    ]);
    const result = await commands.list([], {});
    expect(result.output).toContain('Blocked');
    // blocked issue should appear before the queue section
    const blockedSection = result.output.slice(0, result.output.indexOf('Queue:'));
    expect(blockedSection).toContain('#30');
    // normal issue should be in the queue
    const queueSection = result.output.slice(result.output.indexOf('Queue:'));
    expect(queueSection).toContain('#10');
  });

  it('excludes wontfix and invalid issues', async () => {
    mockGithubApi.mockResolvedValueOnce([
      makeIssue({ number: 1, title: 'Valid issue', labels: [] }),
      makeIssue({ number: 2, title: 'Wontfix', labels: ['wontfix'] }),
      makeIssue({ number: 3, title: 'Invalid', labels: ['invalid'] }),
      makeIssue({ number: 4, title: 'Duplicate', labels: ['duplicate'] }),
    ]);
    const result = await commands.list([], {});
    expect(result.output).not.toContain('#2');
    expect(result.output).not.toContain('#3');
    expect(result.output).not.toContain('#4');
    expect(result.output).toContain('#1');
  });

  it('skips pull requests (issues with pull_request field)', async () => {
    mockGithubApi.mockResolvedValueOnce([
      makeIssue({ number: 1, title: 'Real issue' }),
      makeIssue({ number: 2, title: 'PR not an issue', pull_request: { url: 'https://...' } }),
    ]);
    const result = await commands.list([], {});
    expect(result.output).toContain('#1');
    expect(result.output).not.toContain('#2');
  });

  it('shows zero count message for empty list', async () => {
    mockGithubApi.mockResolvedValueOnce([]);
    const result = await commands.list([], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('0');
  });

  it('returns JSON array when --json flag set', async () => {
    mockGithubApi.mockResolvedValueOnce([
      makeIssue({ number: 42, title: 'JSON test issue', labels: ['P1'] }),
    ]);
    const result = await commands.list([], { json: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].number).toBe(42);
    expect(parsed[0].priority).toBe(1);
    expect(parsed[0]).toHaveProperty('score');
    expect(parsed[0]).toHaveProperty('scoreBreakdown');
  });

  it('shows score breakdown when --scores flag set', async () => {
    mockGithubApi.mockResolvedValueOnce([
      makeIssue({ number: 5, title: 'Bug issue', labels: ['P1', 'bug'] }),
    ]);
    const result = await commands.list([], { scores: true });
    expect(result.output).toContain('score:');
    expect(result.output).toContain('priority:');
    expect(result.output).toContain('bug:+50');
  });

  it('bug label boosts ranking above same-priority non-bug', async () => {
    mockGithubApi.mockResolvedValueOnce([
      makeIssue({ number: 10, title: 'P2 bug', labels: ['P2', 'bug'], created_at: '2026-02-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z' }),
      makeIssue({ number: 20, title: 'P2 feature', labels: ['P2'], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }),
    ]);
    const result = await commands.list([], {});
    const posBug = result.output.indexOf('#10');
    const posFeature = result.output.indexOf('#20');
    expect(posBug).toBeLessThan(posFeature);
  });

  it('claude-ready label boosts ranking', async () => {
    mockGithubApi.mockResolvedValueOnce([
      makeIssue({ number: 10, title: 'P2 claude-ready', labels: ['P2', 'claude-ready'], created_at: '2026-02-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z' }),
      makeIssue({ number: 20, title: 'P2 plain', labels: ['P2'], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }),
    ]);
    const result = await commands.list([], {});
    const posReady = result.output.indexOf('#10');
    const posPlain = result.output.indexOf('#20');
    expect(posReady).toBeLessThan(posPlain);
  });
});

// ---------------------------------------------------------------------------
// next command
// ---------------------------------------------------------------------------

describe('issues next', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns message when no issues available', async () => {
    mockGithubApi.mockResolvedValueOnce([]);
    const result = await commands.next([], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('No open issues');
  });

  it('returns message when all issues are claude-working', async () => {
    mockGithubApi.mockResolvedValueOnce([
      makeIssue({ number: 1, labels: ['claude-working'] }),
    ]);
    const result = await commands.next([], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('claude-working');
  });

  it('shows the highest-priority issue with start command hint', async () => {
    mockGithubApi.mockResolvedValueOnce([
      makeIssue({ number: 5, title: 'Low priority', labels: ['P3'] }),
      makeIssue({ number: 1, title: 'High priority', labels: ['P0'] }),
    ]);
    const result = await commands.next([], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('#1');
    expect(result.output).toContain('High priority');
    expect(result.output).toContain('crux issues start 1');
  });

  it('excludes blocked issues from recommendation', async () => {
    mockGithubApi.mockResolvedValueOnce([
      makeIssue({ number: 1, title: 'P0 but blocked', labels: ['P0', 'blocked'] }),
      makeIssue({ number: 2, title: 'P1 not blocked', labels: ['P1'] }),
    ]);
    const result = await commands.next([], {});
    expect(result.exitCode).toBe(0);
    // P1 non-blocked should be recommended, not P0 blocked
    expect(result.output).toContain('#2');
    expect(result.output).not.toContain('Next Issue: #1');
  });

  it('shows blocked issues in a separate section', async () => {
    mockGithubApi.mockResolvedValueOnce([
      makeIssue({ number: 1, title: 'P0 but blocked', labels: ['P0', 'blocked'] }),
      makeIssue({ number: 2, title: 'P1 not blocked', labels: ['P1'] }),
    ]);
    const result = await commands.next([], {});
    expect(result.output).toContain('Blocked');
    expect(result.output).toContain('#1');
  });

  it('reports when all issues are blocked or in-progress', async () => {
    mockGithubApi.mockResolvedValueOnce([
      makeIssue({ number: 1, labels: ['blocked'] }),
      makeIssue({ number: 2, labels: ['claude-working'] }),
    ]);
    const result = await commands.next([], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('blocked');
  });

  it('returns JSON object when --json flag set', async () => {
    mockGithubApi.mockResolvedValueOnce([
      makeIssue({ number: 7, title: 'Next issue', labels: ['P1'] }),
    ]);
    const result = await commands.next([], { json: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.number).toBe(7);
    expect(parsed.priority).toBe(1);
    expect(parsed).toHaveProperty('score');
    expect(parsed).toHaveProperty('scoreBreakdown');
  });

  it('shows score breakdown when --scores flag set', async () => {
    mockGithubApi.mockResolvedValueOnce([
      makeIssue({ number: 7, title: 'Next issue', labels: ['P1', 'bug'] }),
    ]);
    const result = await commands.next([], { scores: true });
    expect(result.output).toContain('score:');
    expect(result.output).toContain('bug:+50');
  });
});

// ---------------------------------------------------------------------------
// findPotentialDuplicates unit tests
// ---------------------------------------------------------------------------

describe('findPotentialDuplicates', () => {
  function makeRanked(overrides: Partial<Parameters<typeof makeIssue>[0]> = {}) {
    const i = makeIssue(overrides);
    const labels = (overrides.labels ?? []);
    return {
      number: i.number,
      title: i.title,
      body: i.body ?? '',
      labels,
      createdAt: i.created_at.slice(0, 10),
      updatedAt: i.updated_at.slice(0, 10),
      url: i.html_url,
      priority: 99,
      score: 50,
      scoreBreakdown: { priority: 50, bugBonus: 0, claudeReadyBonus: 0, effortAdjustment: 0, recencyBonus: 0, ageBonus: 0, total: 50 },
      inProgress: false,
      blocked: false,
    };
  }

  it('detects issues with very similar titles', () => {
    const issues = [
      makeRanked({ number: 1, title: 'Standardize table column formats across page types' }),
      makeRanked({ number: 2, title: 'Standardize table columns across page types' }),
    ];
    const dups = findPotentialDuplicates(issues);
    expect(dups.length).toBe(1);
    expect(dups[0].similarity).toBeGreaterThan(0.5);
  });

  it('does not flag unrelated issues', () => {
    const issues = [
      makeRanked({ number: 1, title: 'Add Postgres sync layer for citation data' }),
      makeRanked({ number: 2, title: 'Interactive knowledge graph explorer' }),
    ];
    const dups = findPotentialDuplicates(issues);
    expect(dups.length).toBe(0);
  });

  it('detects duplicate with slightly different wording', () => {
    const issues = [
      makeRanked({ number: 1, title: 'Clean up legacy frontmatter fields (importance, lastUpdated, todo, entityId)' }),
      makeRanked({ number: 2, title: 'Clean up legacy frontmatter fields (importance, lastUpdated, todo)' }),
    ];
    const dups = findPotentialDuplicates(issues);
    expect(dups.length).toBe(1);
  });

  it('returns empty array for single issue', () => {
    const issues = [makeRanked({ number: 1, title: 'Some issue' })];
    const dups = findPotentialDuplicates(issues);
    expect(dups.length).toBe(0);
  });

  it('returns empty array for no issues', () => {
    const dups = findPotentialDuplicates([]);
    expect(dups.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// cleanup command
// ---------------------------------------------------------------------------

describe('issues cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports all clean when no claude-working issues and no duplicates', async () => {
    mockGithubApi.mockResolvedValueOnce([
      makeIssue({ number: 1, title: 'Unique issue A' }),
      makeIssue({ number: 2, title: 'Completely different B' }),
    ]);
    const result = await commands.cleanup([], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('No claude-working issues');
    expect(result.output).toContain('No potential duplicates');
  });

  it('detects stale claude-working when branch does not exist', async () => {
    // First call: fetchOpenIssues
    mockGithubApi.mockResolvedValueOnce([
      makeIssue({ number: 10, title: 'WIP issue', labels: ['claude-working'] }),
    ]);
    // Second call: fetch comments for issue #10
    mockGithubApi.mockResolvedValueOnce([
      { body: '🤖 Claude Code starting work.\n\n**Branch:** `claude/test-branch-ABC`', created_at: '2026-02-20' },
    ]);
    // Third call: check branch existence — throw to simulate 404
    mockGithubApi.mockRejectedValueOnce(new Error('GitHub API GET returned 404: not found'));

    const result = await commands.cleanup([], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('does not exist');
    expect(result.output).toContain('stale');
  });
});

// ---------------------------------------------------------------------------
// close command
// ---------------------------------------------------------------------------

describe('issues close — input validation', () => {
  it('returns usage error when no args provided', async () => {
    const result = await commands.close([], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Usage');
    expect(result.output).toContain('close');
  });

  it('returns usage error for non-numeric arg', async () => {
    const result = await commands.close(['abc'], {});
    expect(result.exitCode).toBe(1);
  });
});
