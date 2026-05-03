/**
 * Tests for `crux sys agents` Linear-ID extraction (QUA-580).
 *
 * Mocks the wiki-server client + Linear state cache so the status command
 * can be exercised without a live server or Linear API.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  listActiveAgentsMock,
  getIssueStatesMock,
  isServerAvailableMock,
  syncAndCloseSessionMock,
  gitSafeMock,
  existsSyncMock,
  unlinkSyncMock,
  readFileSyncMock,
} = vi.hoisted(() => ({
  listActiveAgentsMock: vi.fn(),
  getIssueStatesMock: vi.fn(),
  isServerAvailableMock: vi.fn(),
  syncAndCloseSessionMock: vi.fn<
    (...a: unknown[]) => Promise<{ fieldsSync: 'ok' | 'failed' | 'noop'; statusSet: boolean }>
  >(async () => ({ fieldsSync: 'ok' as const, statusSet: true })),
  gitSafeMock: vi.fn(() => ({ ok: true, output: 'claude/qua-1073-fix' })),
  // Mocking fs prevents `closeCommand` from `unlinkSync`-ing the real
  // .claude/agent-id, .claude/wip-checklist.md, .agent-task, and
  // .claude/last-heartbeat in the project root when this test runs in a
  // live slot. Without this, every test invocation destroys the running
  // session's checklist + heartbeat.
  existsSyncMock: vi.fn(() => false),
  unlinkSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(() => ''),
}));

vi.mock('../lib/wiki-server/active-agents.ts', () => ({
  listActiveAgents: listActiveAgentsMock,
  registerAgent: vi.fn(),
  updateAgent: vi.fn(),
  heartbeat: vi.fn(),
  sweepStaleAgents: vi.fn(),
}));

vi.mock('../lib/wiki-server/client.ts', () => ({
  isServerAvailable: isServerAvailableMock,
  apiRequest: vi.fn(),
}));

vi.mock('../lib/wiki-server/agent-sessions.ts', () => ({
  sweepStaleSessions: vi.fn(),
  getAgentSessionByBranch: vi.fn(),
  updateAgentSession: vi.fn(),
}));

vi.mock('../lib/wiki-server/agent-session-events.ts', () => ({
  appendEvent: vi.fn(),
}));

vi.mock('../lib/linear/issue-states-cache.ts', () => ({
  getIssueStates: getIssueStatesMock,
}));

vi.mock('../lib/session/session-sync-payload.ts', () => ({
  syncAndCloseSession: syncAndCloseSessionMock,
}));

vi.mock('../lib/git.ts', () => ({
  gitSafe: gitSafeMock,
}));

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  unlinkSync: unlinkSyncMock,
  readFileSync: readFileSyncMock,
}));

import { commands, collectLinearIds } from './agents.ts';
import type { ActiveAgentEntry } from '../lib/wiki-server/active-agents.ts';

function agentFixture(overrides: Partial<ActiveAgentEntry> = {}): ActiveAgentEntry {
  return {
    id: 1,
    sessionId: 'session-1',
    sessionName: 'brave-pine',
    branch: 'claude/qua-580-surface-linear-state',
    task: 'do QUA-580',
    status: 'active',
    startedAt: '2026-04-17T00:00:00Z',
    heartbeatAt: '2026-04-17T00:01:00Z',
    issueNumber: null,
    prNumber: null,
    model: null,
    currentStep: null,
    filesTouched: null,
    worktree: null,
    completedAt: null,
    metadata: null,
    createdAt: '2026-04-17T00:00:00Z',
    updatedAt: '2026-04-17T00:00:00Z',
    linearId: null,
    slotNumber: null,
    ...overrides,
  } as ActiveAgentEntry;
}

describe('collectLinearIds', () => {
  it('extracts Linear IDs from agent branches', () => {
    const agents = [
      agentFixture({ id: 1, branch: 'claude/qua-580-description' }),
      agentFixture({ id: 2, branch: 'claude/qua-564-phase-b1' }),
      agentFixture({ id: 3, branch: 'main' }),
      agentFixture({ id: 4, branch: 'claude/fix-239-something' }),
      agentFixture({ id: 5, branch: null }),
    ];
    const linearIds = collectLinearIds(agents);
    expect(linearIds.get(1)).toBe('QUA-580');
    expect(linearIds.get(2)).toBe('QUA-564');
    expect(linearIds.get(3)).toBeNull();
    expect(linearIds.get(4)).toBeNull();
    expect(linearIds.get(5)).toBeNull();
  });

  it('prefers the server-provided linearId over branch parsing', () => {
    const agents = [
      agentFixture({ id: 1, branch: 'main', linearId: 'QUA-42' }),
      agentFixture({ id: 2, branch: 'claude/qua-100-x', linearId: 'QUA-200' }),
    ];
    const linearIds = collectLinearIds(agents);
    expect(linearIds.get(1)).toBe('QUA-42');
    expect(linearIds.get(2)).toBe('QUA-200');
  });

  it('handles an empty agent list', () => {
    const linearIds = collectLinearIds([]);
    expect(linearIds.size).toBe(0);
  });
});

describe('status command (agents)', () => {
  beforeEach(() => {
    listActiveAgentsMock.mockReset();
    getIssueStatesMock.mockReset();
    isServerAvailableMock.mockReset();
    isServerAvailableMock.mockResolvedValue(true);
  });

  it('emits a "Linear:" line with state when a branch maps to a ticket', async () => {
    listActiveAgentsMock.mockResolvedValue({
      ok: true,
      data: {
        agents: [agentFixture({ id: 1, branch: 'claude/qua-580-surface-linear-state' })],
        conflicts: [],
        directoryConflicts: [],
      },
    });
    getIssueStatesMock.mockResolvedValue(new Map([['QUA-580', 'In Progress']]));

    const result = await commands.status([], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('QUA-580');
    expect(result.output).toContain('In Progress');
    expect(getIssueStatesMock).toHaveBeenCalledWith(['QUA-580']);
  });

  it('shows "—" when an agent branch has no Linear ID', async () => {
    listActiveAgentsMock.mockResolvedValue({
      ok: true,
      data: {
        agents: [agentFixture({ id: 1, branch: 'main' })],
        conflicts: [],
        directoryConflicts: [],
      },
    });
    getIssueStatesMock.mockResolvedValue(new Map());

    const result = await commands.status([], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Linear: —');
  });

  it('shows the Linear ID with "—" state when Linear returns no match', async () => {
    listActiveAgentsMock.mockResolvedValue({
      ok: true,
      data: {
        agents: [agentFixture({ id: 1, branch: 'claude/qua-999-missing' })],
        conflicts: [],
        directoryConflicts: [],
      },
    });
    getIssueStatesMock.mockResolvedValue(new Map([['QUA-999', null]]));

    const result = await commands.status([], {});
    expect(result.output).toContain('QUA-999');
    expect(result.output).toMatch(/Linear:[^\n]*QUA-999[^\n]*—/);
  });

  it('includes linearId and linearState in --json output', async () => {
    listActiveAgentsMock.mockResolvedValue({
      ok: true,
      data: {
        agents: [
          agentFixture({ id: 1, branch: 'claude/qua-580-test' }),
          agentFixture({ id: 2, branch: 'main' }),
        ],
        conflicts: [],
        directoryConflicts: [],
      },
    });
    getIssueStatesMock.mockResolvedValue(new Map([['QUA-580', 'In Progress']]));

    const result = await commands.status([], { json: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.agents[0].linearId).toBe('QUA-580');
    expect(parsed.agents[0].linearState).toBe('In Progress');
    expect(parsed.agents[1].linearId).toBeNull();
    expect(parsed.agents[1].linearState).toBeNull();
  });

  it('returns exit 1 when the wiki-server is unavailable', async () => {
    isServerAvailableMock.mockResolvedValueOnce(false);
    const result = await commands.status([], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/not reachable/i);
    expect(getIssueStatesMock).not.toHaveBeenCalled();
  });
});

// QUA-1073: PATCH must include checksYaml/reviewed/prUrl, not just status.
describe('close command (agents)', () => {
  beforeEach(async () => {
    listActiveAgentsMock.mockReset();
    getIssueStatesMock.mockReset();
    isServerAvailableMock.mockReset();
    syncAndCloseSessionMock.mockReset();
    syncAndCloseSessionMock.mockResolvedValue({ fieldsSync: 'ok', statusSet: true });
    gitSafeMock.mockReset();
    gitSafeMock.mockReturnValue({ ok: true, output: 'claude/qua-1073-fix' });
    isServerAvailableMock.mockResolvedValue(true);
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(false);
    unlinkSyncMock.mockReset();
    readFileSyncMock.mockReset();
    readFileSyncMock.mockReturnValue('');
    const sessions = await import('../lib/wiki-server/agent-sessions.ts');
    vi.mocked(sessions.getAgentSessionByBranch).mockReset();
    vi.mocked(sessions.updateAgentSession).mockReset();
  });

  // QUA-1073: must call syncAndCloseSession (which split-PATCHes the
  // close-time fields and the status promotion separately).
  it('calls syncAndCloseSession on active session (QUA-1073)', async () => {
    const sessions = await import('../lib/wiki-server/agent-sessions.ts');
    const getByBranchMock = vi.mocked(sessions.getAgentSessionByBranch);

    getByBranchMock.mockResolvedValueOnce({
      ok: true,
      data: { id: 99, status: 'active' },
    } as Awaited<ReturnType<typeof sessions.getAgentSessionByBranch>>);

    await commands.close([], {});

    // No skipPrLookup — `close` runs after the push.
    expect(syncAndCloseSessionMock).toHaveBeenCalledWith(
      99,
      sessions.updateAgentSession,
      expect.objectContaining({ branch: 'claude/qua-1073-fix' }),
    );
  });

  // QUA-1073 follow-up: a long session (>2h) gets swept to 'stale'.
  // `agents close` must still sync close-time fields on explicit close.
  it('calls syncAndCloseSession when session is stale (not just active)', async () => {
    const sessions = await import('../lib/wiki-server/agent-sessions.ts');
    const getByBranchMock = vi.mocked(sessions.getAgentSessionByBranch);

    getByBranchMock.mockResolvedValueOnce({
      ok: true,
      data: { id: 477, status: 'stale' },
    } as Awaited<ReturnType<typeof sessions.getAgentSessionByBranch>>);

    await commands.close([], {});

    expect(syncAndCloseSessionMock).toHaveBeenCalledWith(
      477,
      sessions.updateAgentSession,
      expect.objectContaining({ branch: 'claude/qua-1073-fix' }),
    );
  });

  it('skips sync when session is already completed (terminal state)', async () => {
    const sessions = await import('../lib/wiki-server/agent-sessions.ts');
    const getByBranchMock = vi.mocked(sessions.getAgentSessionByBranch);

    getByBranchMock.mockResolvedValueOnce({
      ok: true,
      data: { id: 999, status: 'completed' },
    } as Awaited<ReturnType<typeof sessions.getAgentSessionByBranch>>);

    await commands.close([], {});

    expect(syncAndCloseSessionMock).not.toHaveBeenCalled();
  });

  // QUA-1073: when title/summary haven't been set yet (the steady
  // state for `agents close` since session-finalize hasn't fired),
  // the status promotion silently 400s. The close path should
  // still surface this so the operator knows status didn't flip.
  it('surfaces status-not-set note when statusSet is false', async () => {
    const sessions = await import('../lib/wiki-server/agent-sessions.ts');
    const getByBranchMock = vi.mocked(sessions.getAgentSessionByBranch);

    getByBranchMock.mockResolvedValueOnce({
      ok: true,
      data: { id: 102, status: 'active' },
    } as Awaited<ReturnType<typeof sessions.getAgentSessionByBranch>>);

    syncAndCloseSessionMock.mockResolvedValueOnce({
      fieldsSync: 'ok',
      statusSet: false,
    });

    const result = await commands.close([], {});
    expect(result.output).toMatch(/title\/summary not yet set/);
  });

  // CodeRabbit finding: a transient lookup failure used to be
  // swallowed → close path skipped → cleanup still ran → operator
  // lost .claude/wip-checklist.md and had no retry signal. The fix
  // distinguishes "thrown" from "not_found" and preserves cleanup
  // state so the operator can rerun once the wiki-server recovers.
  it('skips local-file cleanup when getAgentSessionByBranch throws (transport error)', async () => {
    const sessions = await import('../lib/wiki-server/agent-sessions.ts');
    const getByBranchMock = vi.mocked(sessions.getAgentSessionByBranch);

    getByBranchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await commands.close([], {});

    // Surface the failure + the retry hint.
    expect(result.output).toMatch(/Failed to look up agent session/);
    expect(result.output).toMatch(/ECONNREFUSED/);
    expect(result.output).toMatch(/Skipping cleanup/);
    expect(result.exitCode).toBe(1);
    // Cleanup loop must NOT have fired — no `unlinkSync` calls.
    expect(unlinkSyncMock).not.toHaveBeenCalled();
    // Sync helper never ran (no session id to sync against).
    expect(syncAndCloseSessionMock).not.toHaveBeenCalled();
  });

  it('skips cleanup when fields sync fails (transport error during PATCH)', async () => {
    const sessions = await import('../lib/wiki-server/agent-sessions.ts');
    const getByBranchMock = vi.mocked(sessions.getAgentSessionByBranch);

    getByBranchMock.mockResolvedValueOnce({
      ok: true,
      data: { id: 200, status: 'active' },
    } as Awaited<ReturnType<typeof sessions.getAgentSessionByBranch>>);

    syncAndCloseSessionMock.mockResolvedValueOnce({
      fieldsSync: 'failed',
      statusSet: false,
    });

    const result = await commands.close([], {});

    expect(result.exitCode).toBe(1);
    expect(unlinkSyncMock).not.toHaveBeenCalled();
    expect(result.output).toMatch(/Cleanup skipped/);
  });

  it('still cleans up when session is already completed (no transport failure)', async () => {
    // Already-completed sessions don't need a sync, and we
    // shouldn't punish the operator with cleanup-skip — the close
    // succeeded conceptually (it was already closed). Also asserts
    // the cleanup-skip is properly scoped to actual transport failures.
    const sessions = await import('../lib/wiki-server/agent-sessions.ts');
    const getByBranchMock = vi.mocked(sessions.getAgentSessionByBranch);
    // Make existsSync return true for the local files so unlinkSync
    // gets called (the loop short-circuits on file-not-exist).
    existsSyncMock.mockReturnValue(true);

    getByBranchMock.mockResolvedValueOnce({
      ok: true,
      data: { id: 999, status: 'completed' },
    } as Awaited<ReturnType<typeof sessions.getAgentSessionByBranch>>);

    const result = await commands.close([], {});

    expect(result.exitCode).toBe(0);
    expect(unlinkSyncMock).toHaveBeenCalled();
  });
});
