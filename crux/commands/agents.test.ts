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
  buildCloseUpdatesMock,
  gitSafeMock,
  existsSyncMock,
  unlinkSyncMock,
  readFileSyncMock,
} = vi.hoisted(() => ({
  listActiveAgentsMock: vi.fn(),
  getIssueStatesMock: vi.fn(),
  isServerAvailableMock: vi.fn(),
  buildCloseUpdatesMock: vi.fn<
    (...a: unknown[]) => Promise<{ status: 'completed' } & Record<string, unknown>>
  >(async () => ({ status: 'completed' as const })),
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
  buildCloseUpdates: buildCloseUpdatesMock,
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
    buildCloseUpdatesMock.mockReset();
    buildCloseUpdatesMock.mockResolvedValue({ status: 'completed' as const });
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

  it('PATCHes the close-time payload alongside status (QUA-1073)', async () => {
    const sessions = await import('../lib/wiki-server/agent-sessions.ts');
    const updateMock = vi.mocked(sessions.updateAgentSession);
    const getByBranchMock = vi.mocked(sessions.getAgentSessionByBranch);

    getByBranchMock.mockResolvedValueOnce({
      ok: true,
      data: { id: 99, status: 'active' },
    } as Awaited<ReturnType<typeof sessions.getAgentSessionByBranch>>);

    buildCloseUpdatesMock.mockResolvedValueOnce({
      status: 'completed',
      checksYaml: '{"initialized":true,"completed":3}',
      reviewed: false,
      prUrl: 'https://github.com/quantified-uncertainty/longterm-wiki/pull/9999',
    });

    await commands.close([], {});

    // No skipPrLookup — `close` runs after the push.
    expect(buildCloseUpdatesMock).toHaveBeenCalledWith({
      branch: 'claude/qua-1073-fix',
    });

    expect(updateMock).toHaveBeenCalledWith(99, {
      status: 'completed',
      checksYaml: '{"initialized":true,"completed":3}',
      reviewed: false,
      prUrl: 'https://github.com/quantified-uncertainty/longterm-wiki/pull/9999',
    });
  });

  it('still sends just status when no local artifacts exist', async () => {
    const sessions = await import('../lib/wiki-server/agent-sessions.ts');
    const updateMock = vi.mocked(sessions.updateAgentSession);
    const getByBranchMock = vi.mocked(sessions.getAgentSessionByBranch);

    getByBranchMock.mockResolvedValueOnce({
      ok: true,
      data: { id: 100, status: 'active' },
    } as Awaited<ReturnType<typeof sessions.getAgentSessionByBranch>>);

    buildCloseUpdatesMock.mockResolvedValueOnce({ status: 'completed' });

    await commands.close([], {});

    expect(updateMock).toHaveBeenCalledWith(100, { status: 'completed' });
  });

  // QUA-1073 follow-up: a long session (>2h) gets swept to 'stale'
  // by the periodic sweep. `agents close` must still populate the
  // close-time fields on explicit close — otherwise any long-running
  // session lands with NULL writeback even after the QUA-1073 fix.
  it('PATCHes the close-time payload when session is stale (not just active)', async () => {
    const sessions = await import('../lib/wiki-server/agent-sessions.ts');
    const updateMock = vi.mocked(sessions.updateAgentSession);
    const getByBranchMock = vi.mocked(sessions.getAgentSessionByBranch);

    getByBranchMock.mockResolvedValueOnce({
      ok: true,
      data: { id: 477, status: 'stale' },
    } as Awaited<ReturnType<typeof sessions.getAgentSessionByBranch>>);

    buildCloseUpdatesMock.mockResolvedValueOnce({
      status: 'completed',
      checksYaml: '{"initialized":true}',
      reviewed: true,
      prUrl: 'https://github.com/quantified-uncertainty/longterm-wiki/pull/4854',
    });

    await commands.close([], {});

    expect(updateMock).toHaveBeenCalledWith(477, {
      status: 'completed',
      checksYaml: '{"initialized":true}',
      reviewed: true,
      prUrl: 'https://github.com/quantified-uncertainty/longterm-wiki/pull/4854',
    });
  });

  it('skips PATCH when session is already completed (terminal state)', async () => {
    const sessions = await import('../lib/wiki-server/agent-sessions.ts');
    const updateMock = vi.mocked(sessions.updateAgentSession);
    const getByBranchMock = vi.mocked(sessions.getAgentSessionByBranch);

    getByBranchMock.mockResolvedValueOnce({
      ok: true,
      data: { id: 999, status: 'completed' },
    } as Awaited<ReturnType<typeof sessions.getAgentSessionByBranch>>);

    await commands.close([], {});

    expect(updateMock).not.toHaveBeenCalled();
  });

  // Speculative `buildCloseUpdates` rejection: the close path must
  // surface a warning and fall back to `{status:'completed'}` so the
  // row leaves its prior state. Silently swallowing the error would
  // re-create the QUA-1073 NULL-writeback failure mode.
  it('surfaces buildCloseUpdates rejection and falls back to status-only PATCH', async () => {
    const sessions = await import('../lib/wiki-server/agent-sessions.ts');
    const updateMock = vi.mocked(sessions.updateAgentSession);
    const getByBranchMock = vi.mocked(sessions.getAgentSessionByBranch);

    getByBranchMock.mockResolvedValueOnce({
      ok: true,
      data: { id: 101, status: 'active' },
    } as Awaited<ReturnType<typeof sessions.getAgentSessionByBranch>>);

    buildCloseUpdatesMock.mockRejectedValueOnce(
      new Error('checklist parse failed'),
    );

    const result = await commands.close([], {});

    expect(updateMock).toHaveBeenCalledWith(101, { status: 'completed' });
    expect(result.output).toMatch(/Failed to build close-time payload/);
    expect(result.output).toMatch(/checklist parse failed/);
  });
});
