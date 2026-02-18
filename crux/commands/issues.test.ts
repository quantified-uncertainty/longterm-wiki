/**
 * Tests for crux/commands/issues.ts
 *
 * Focus areas:
 * - Input validation (start/done reject bad args)
 * - Priority ranking logic (via list command with mocked GitHub data)
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

import { commands } from './issues.ts';
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
      makeIssue({ number: 5, title: 'Newer P1', labels: ['P1'], created_at: '2026-02-01T00:00:00Z' }),
      makeIssue({ number: 3, title: 'Older P1', labels: ['P1'], created_at: '2026-01-01T00:00:00Z' }),
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

  it('returns JSON object when --json flag set', async () => {
    mockGithubApi.mockResolvedValueOnce([
      makeIssue({ number: 7, title: 'Next issue', labels: ['P1'] }),
    ]);
    const result = await commands.next([], { json: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.number).toBe(7);
    expect(parsed.priority).toBe(1);
  });
});
