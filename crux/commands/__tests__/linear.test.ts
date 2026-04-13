/**
 * Tests for crux/commands/linear.ts — the CLI handlers that wrap the
 * Linear issue helpers. The transport is fully mocked via vi.hoisted +
 * vi.mock so these tests never hit the network.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted mocks — vi.mock runs before imports so we hoist the spies.
const {
  getIssueMock,
  getCommentsMock,
  updateIssueStateMock,
  commentOnIssueMock,
  searchIssuesMock,
  fetchRemoteWorkflowStatesMock,
} = vi.hoisted(() => ({
  getIssueMock: vi.fn(),
  getCommentsMock: vi.fn(),
  updateIssueStateMock: vi.fn(),
  commentOnIssueMock: vi.fn(),
  searchIssuesMock: vi.fn(),
  fetchRemoteWorkflowStatesMock: vi.fn(),
}));

vi.mock('../../lib/linear/issues.ts', () => ({
  getIssue: getIssueMock,
  getComments: getCommentsMock,
  updateIssueState: updateIssueStateMock,
  commentOnIssue: commentOnIssueMock,
  searchIssues: searchIssuesMock,
}));

vi.mock('../../lib/linear/workflow-states.ts', () => ({
  fetchRemoteWorkflowStates: fetchRemoteWorkflowStatesMock,
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(() => 'claude/qua-184-test-branch'),
}));

import { commands } from '../linear.ts';

const mockIssue = {
  id: 'uuid-1',
  identifier: 'QUA-184',
  title: 'Test issue',
  description: 'body content',
  priority: 2,
  url: 'https://linear.app/quantifieduncertainty/issue/QUA-184',
  state: { id: 'state-1', name: 'Backlog', type: 'backlog' },
  team: { id: 'team-1', key: 'QUA' },
  parent: null,
  project: null,
  labels: { nodes: [] },
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// view
// ---------------------------------------------------------------------------

describe('linear view', () => {
  it('prints usage when no identifier is given', async () => {
    const r = await commands.view([], { ci: true });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('Usage');
  });

  it('prints not-found when the issue does not exist', async () => {
    getIssueMock.mockResolvedValueOnce(null);
    const r = await commands.view(['QUA-9999'], { ci: true });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('not found');
  });

  it('prints the full issue on success', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    getCommentsMock.mockResolvedValueOnce([]);

    const r = await commands.view(['QUA-184'], { ci: true });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('QUA-184');
    expect(r.output).toContain('Test issue');
    expect(r.output).toContain('Backlog');
  });

  it('emits JSON when --json is set', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    getCommentsMock.mockResolvedValueOnce([]);

    const r = await commands.view(['QUA-184'], { ci: true, json: true });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.output);
    expect(parsed.issue.identifier).toBe('QUA-184');
    expect(parsed.comments).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

describe('linear search', () => {
  it('prints usage when the query is empty', async () => {
    const r = await commands.search([], { ci: true });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('Usage');
  });

  it('filters out --flag args from the query string', async () => {
    // The CLI dispatcher appends flags as positional args — the handler
    // must filter them out so `--limit=5` doesn't leak into the query.
    searchIssuesMock.mockResolvedValueOnce([]);
    await commands.search(['agent', 'tooling', '--limit=5'], { ci: true, limit: '5' });

    expect(searchIssuesMock).toHaveBeenCalledWith('agent tooling', 5);
  });

  it('passes --limit as the numeric limit', async () => {
    searchIssuesMock.mockResolvedValueOnce([]);
    await commands.search(['foo'], { ci: true, limit: '3' });
    expect(searchIssuesMock).toHaveBeenCalledWith('foo', 3);
  });

  it('prints a tidy no-matches message on empty results', async () => {
    searchIssuesMock.mockResolvedValueOnce([]);
    const r = await commands.search(['foo'], { ci: true });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('No matches');
  });

  it('prints results in a readable format', async () => {
    searchIssuesMock.mockResolvedValueOnce([
      {
        identifier: 'QUA-1',
        title: 'A title',
        priority: 2,
        state: { name: 'Backlog', type: 'backlog' },
        url: 'u',
      },
    ]);
    const r = await commands.search(['foo'], { ci: true });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('QUA-1');
    expect(r.output).toContain('A title');
    expect(r.output).toContain('high'); // priority 2 = high
  });
});

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

describe('linear start', () => {
  it('prints usage when no ID is given', async () => {
    const r = await commands.start([], { ci: true });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('Usage');
  });

  it('prints not-found when the issue does not exist', async () => {
    getIssueMock.mockResolvedValueOnce(null);
    const r = await commands.start(['QUA-9999'], { ci: true });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('not found');
  });

  it('moves the issue to In Progress and posts a start comment', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    updateIssueStateMock.mockResolvedValueOnce({
      identifier: 'QUA-184',
      state: 'In Progress',
    });
    commentOnIssueMock.mockResolvedValueOnce(undefined);

    const r = await commands.start(['QUA-184'], { ci: true });
    expect(r.exitCode).toBe(0);
    expect(updateIssueStateMock).toHaveBeenCalledWith('QUA-184', 'In Progress');
    expect(commentOnIssueMock).toHaveBeenCalledWith(
      'QUA-184',
      expect.stringContaining('starting work')
    );
    const commentBody = commentOnIssueMock.mock.calls[0][1];
    // Branch name (from mocked execSync) is in the comment
    expect(commentBody).toContain('claude/qua-184-test-branch');
    // Enriched fields (QUA-336): branch is a claude/* branch so no main warning
    expect(commentBody).not.toContain('⚠');
    // Host is always set (from os.hostname()) — assert the field label is present
    expect(commentBody).toContain('**Host:**');
  });
});

// ---------------------------------------------------------------------------
// done — CRITICAL: branching logic between "In Review" (with PR) and "Done"
// ---------------------------------------------------------------------------

describe('linear done', () => {
  it('prints usage when no ID is given', async () => {
    const r = await commands.done([], { ci: true });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('Usage');
  });

  it('moves to In Review and includes the PR URL in the comment when --pr is set', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    updateIssueStateMock.mockResolvedValueOnce({
      identifier: 'QUA-184',
      state: 'In Review',
    });
    commentOnIssueMock.mockResolvedValueOnce(undefined);

    const r = await commands.done(['QUA-184'], {
      ci: true,
      pr: 'https://github.com/example/repo/pull/42',
    });
    expect(r.exitCode).toBe(0);
    expect(updateIssueStateMock).toHaveBeenCalledWith('QUA-184', 'In Review');

    const commentBody = commentOnIssueMock.mock.calls[0][1];
    expect(commentBody).toContain('finished work');
    expect(commentBody).toContain('https://github.com/example/repo/pull/42');
    expect(r.output).toContain('In Review');
  });

  it('moves straight to Done when --pr is NOT set', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    updateIssueStateMock.mockResolvedValueOnce({
      identifier: 'QUA-184',
      state: 'Done',
    });
    commentOnIssueMock.mockResolvedValueOnce(undefined);

    const r = await commands.done(['QUA-184'], { ci: true });
    expect(r.exitCode).toBe(0);
    expect(updateIssueStateMock).toHaveBeenCalledWith('QUA-184', 'Done');

    const commentBody = commentOnIssueMock.mock.calls[0][1];
    expect(commentBody).not.toContain('**PR:**');
    expect(r.output).toContain('Done');
  });

  it('prints not-found when the issue does not exist', async () => {
    getIssueMock.mockResolvedValueOnce(null);
    const r = await commands.done(['QUA-99999'], { ci: true });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('not found');
    expect(updateIssueStateMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// comment
// ---------------------------------------------------------------------------

describe('linear comment', () => {
  it('prints usage when no ID is given', async () => {
    const r = await commands.comment([], { ci: true });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('Usage');
  });

  it('rejects an empty body', async () => {
    const r = await commands.comment(['QUA-184'], { ci: true });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('empty');
  });

  it('posts the inline body when provided', async () => {
    commentOnIssueMock.mockResolvedValueOnce(undefined);

    const r = await commands.comment(['QUA-184', 'hello', 'world'], { ci: true });
    expect(r.exitCode).toBe(0);
    expect(commentOnIssueMock).toHaveBeenCalledWith('QUA-184', 'hello world');
  });

  it('filters out --flag args from the inline body', async () => {
    commentOnIssueMock.mockResolvedValueOnce(undefined);
    await commands.comment(
      ['QUA-184', 'a', 'note', '--body-file=ignored.md'],
      { ci: true }
    );
    // args.slice(1) with flag filter should produce "a note" (no --body-file=...)
    const [, body] = commentOnIssueMock.mock.calls[0];
    expect(body).toBe('a note');
  });
});

// ---------------------------------------------------------------------------
// states-list
// ---------------------------------------------------------------------------

describe('linear states-list', () => {
  it('prints state names in position order', async () => {
    fetchRemoteWorkflowStatesMock.mockResolvedValueOnce([
      { id: 's1', name: 'Done', type: 'completed', position: 3 },
      { id: 's2', name: 'Backlog', type: 'backlog', position: 0 },
      { id: 's3', name: 'In Progress', type: 'started', position: 2 },
    ]);

    const r = await commands['states-list']([], { ci: true });
    expect(r.exitCode).toBe(0);
    // Should be sorted: Backlog (0), In Progress (2), Done (3)
    const backlogIdx = r.output.indexOf('Backlog');
    const progressIdx = r.output.indexOf('In Progress');
    const doneIdx = r.output.indexOf('Done');
    expect(backlogIdx).toBeGreaterThanOrEqual(0);
    expect(progressIdx).toBeGreaterThan(backlogIdx);
    expect(doneIdx).toBeGreaterThan(progressIdx);
  });

  it('emits JSON when --json is set', async () => {
    fetchRemoteWorkflowStatesMock.mockResolvedValueOnce([
      { id: 's1', name: 'Backlog', type: 'backlog', position: 0 },
    ]);
    const r = await commands['states-list']([], { ci: true, json: true });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.output);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('Backlog');
  });
});

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

describe('linear parse', () => {
  it('prints the canonical ID when one is found', async () => {
    const r = await commands.parse(['claude/qua-184-foo'], { ci: true });
    expect(r.exitCode).toBe(0);
    expect(r.output.trim()).toBe('QUA-184');
  });

  it('exits non-zero when no ID is found', async () => {
    const r = await commands.parse(['no id'], { ci: true });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('No Linear ID found');
  });

  it('filters out --flag args from the parse input', async () => {
    const r = await commands.parse(['claude/qua-184-foo', '--json'], { ci: true });
    expect(r.exitCode).toBe(0);
    expect(r.output.trim()).toBe('QUA-184');
  });
});
