import { describe, it, expect } from 'vitest';
import { shouldSkipPr, type RebaseCandidate } from './pr-rebase.ts';

// Helper to create a base candidate with sensible defaults
function makeCandidate(overrides: Partial<RebaseCandidate> = {}): RebaseCandidate {
  return {
    number: 42,
    branch: 'claude/some-feature',
    updatedAt: '2026-01-01T00:00:00Z',
    labels: [],
    ...overrides,
  };
}

const ONE_HOUR = 3600;
const RECENT_WINDOW = 1800; // 30 minutes

// A "now" epoch that is far in the future relative to the default updatedAt
const NOW = Math.floor(new Date('2026-01-01T02:00:00Z').getTime() / 1000);
// A branch tip epoch that is also old (1 hour ago)
const OLD_BRANCH_TIP = NOW - ONE_HOUR;

describe('shouldSkipPr', () => {
  it('skips PR with claude-working label', () => {
    const pr = makeCandidate({ labels: ['claude-working', 'enhancement'] });
    const result = shouldSkipPr(pr, NOW, OLD_BRANCH_TIP, 'fix: some change', RECENT_WINDOW);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain('claude-working');
  });

  it('skips recently updated PR', () => {
    // PR was updated 10 minutes ago
    const recentUpdate = new Date((NOW - 600) * 1000).toISOString();
    const pr = makeCandidate({ updatedAt: recentUpdate });
    const result = shouldSkipPr(pr, NOW, OLD_BRANCH_TIP, 'fix: some change', RECENT_WINDOW);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain('PR updated');
    expect(result.reason).toContain('600s ago');
  });

  it('skips when branch tip was pushed recently', () => {
    const pr = makeCandidate();
    const recentBranchTip = NOW - 600; // 10 minutes ago
    const result = shouldSkipPr(pr, NOW, recentBranchTip, 'fix: some change', RECENT_WINDOW);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain('branch tip');
    expect(result.reason).toContain('600s old');
  });

  it('skips when last commit is ci-autofix', () => {
    const pr = makeCandidate();
    const result = shouldSkipPr(pr, NOW, OLD_BRANCH_TIP, '[ci-autofix] fix escaping', RECENT_WINDOW);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain('ci-autofix');
  });

  it('skips when last commit contains [ci-autofix] case-insensitively', () => {
    const pr = makeCandidate();
    const result = shouldSkipPr(pr, NOW, OLD_BRANCH_TIP, '[CI-AUTOFIX] fix formatting', RECENT_WINDOW);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain('ci-autofix');
  });

  it('does not skip an old PR with old branch tip and normal commit', () => {
    const pr = makeCandidate();
    const result = shouldSkipPr(pr, NOW, OLD_BRANCH_TIP, 'feat: add new feature', RECENT_WINDOW);
    expect(result.skip).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it('does not skip when PR age is exactly at the window boundary', () => {
    // PR was updated exactly 30 minutes ago — age == recentWindow, not < recentWindow
    const exactBoundary = new Date((NOW - RECENT_WINDOW) * 1000).toISOString();
    const pr = makeCandidate({ updatedAt: exactBoundary });
    const result = shouldSkipPr(pr, NOW, OLD_BRANCH_TIP, 'fix: change', RECENT_WINDOW);
    expect(result.skip).toBe(false);
  });

  it('does not skip when branch tip age is exactly at the window boundary', () => {
    const pr = makeCandidate();
    const exactBranchTip = NOW - RECENT_WINDOW; // exactly 30 minutes old
    const result = shouldSkipPr(pr, NOW, exactBranchTip, 'fix: change', RECENT_WINDOW);
    expect(result.skip).toBe(false);
  });

  it('respects custom recent window', () => {
    // PR was updated 20 minutes ago — within default 30-min window but outside custom 10-min window
    const twentyMinAgo = new Date((NOW - 1200) * 1000).toISOString();
    const pr = makeCandidate({ updatedAt: twentyMinAgo });

    // With default 30-min window: should skip
    expect(shouldSkipPr(pr, NOW, OLD_BRANCH_TIP, 'fix: change', 1800).skip).toBe(true);

    // With custom 10-min window: should not skip
    expect(shouldSkipPr(pr, NOW, OLD_BRANCH_TIP, 'fix: change', 600).skip).toBe(false);
  });

  it('checks safeguards in priority order (label first)', () => {
    // PR has both claude-working label AND recent activity — should mention label
    const recentUpdate = new Date((NOW - 60) * 1000).toISOString();
    const pr = makeCandidate({ labels: ['claude-working'], updatedAt: recentUpdate });
    const result = shouldSkipPr(pr, NOW, NOW - 60, '[ci-autofix] fix', RECENT_WINDOW);
    expect(result.skip).toBe(true);
    expect(result.reason).toContain('claude-working');
  });
});
