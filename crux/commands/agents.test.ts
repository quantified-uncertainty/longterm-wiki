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
} = vi.hoisted(() => ({
  listActiveAgentsMock: vi.fn(),
  getIssueStatesMock: vi.fn(),
  isServerAvailableMock: vi.fn(),
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
    const { linearIds, uniqueIds } = collectLinearIds(agents);
    expect(linearIds.get(1)).toBe('QUA-580');
    expect(linearIds.get(2)).toBe('QUA-564');
    expect(linearIds.get(3)).toBeNull();
    expect(linearIds.get(4)).toBeNull();
    expect(linearIds.get(5)).toBeNull();
    expect(uniqueIds.sort()).toEqual(['QUA-564', 'QUA-580']);
  });

  it('prefers the server-provided linearId over branch parsing', () => {
    const agents = [
      agentFixture({ id: 1, branch: 'main', linearId: 'QUA-42' }),
      agentFixture({ id: 2, branch: 'claude/qua-100-x', linearId: 'QUA-200' }),
    ];
    const { linearIds } = collectLinearIds(agents);
    expect(linearIds.get(1)).toBe('QUA-42');
    expect(linearIds.get(2)).toBe('QUA-200');
  });

  it('deduplicates repeated Linear IDs across agents', () => {
    const agents = [
      agentFixture({ id: 1, branch: 'claude/qua-100-a' }),
      agentFixture({ id: 2, branch: 'claude/qua-100-b' }),
    ];
    const { uniqueIds } = collectLinearIds(agents);
    expect(uniqueIds).toEqual(['QUA-100']);
  });

  it('handles an empty agent list', () => {
    const { linearIds, uniqueIds } = collectLinearIds([]);
    expect(linearIds.size).toBe(0);
    expect(uniqueIds).toEqual([]);
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
