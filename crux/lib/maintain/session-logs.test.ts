import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the wiki-server client BEFORE importing session-logs
vi.mock('../wiki-server/agent-sessions.ts', () => ({
  listAgentSessions: vi.fn(),
}));

import { loadSessionLogsSince } from './session-logs.ts';
import { listAgentSessions } from '../wiki-server/agent-sessions.ts';

const mockListAgentSessions = vi.mocked(listAgentSessions);

function apiOk<T>(data: T) {
  return { ok: true as const, data };
}

describe('loadSessionLogsSince', () => {
  beforeEach(() => {
    mockListAgentSessions.mockReset();
  });

  it('falls back to startedAt when date is null', async () => {
    mockListAgentSessions.mockResolvedValue(
      apiOk({
        sessions: [
          {
            id: 1, branch: 'claude/foo', date: null,
            startedAt: '2026-04-16T12:00:00.000Z',
            title: 'A', summary: 'S',
            issuesJson: null, learningsJson: null,
          },
        ] as any,
      }) as any
    );

    const entries = await loadSessionLogsSince('2026-04-09');
    expect(entries).toHaveLength(1);
    expect(entries[0].date).toBe('2026-04-16');
    expect(entries[0].branch).toBe('claude/foo');
  });

  it('prefers explicit date over startedAt when both are present', async () => {
    mockListAgentSessions.mockResolvedValue(
      apiOk({
        sessions: [
          {
            id: 1, branch: 'claude/foo',
            date: '2026-04-15',
            startedAt: '2026-04-16T12:00:00.000Z',
            title: 'A', summary: 'S',
            issuesJson: null, learningsJson: null,
          },
        ] as any,
      }) as any
    );

    const entries = await loadSessionLogsSince('2026-04-09');
    expect(entries[0].date).toBe('2026-04-15');
  });

  it('drops rows before the since threshold regardless of which field is used', async () => {
    mockListAgentSessions.mockResolvedValue(
      apiOk({
        sessions: [
          {
            id: 1, branch: 'claude/old', date: null,
            startedAt: '2026-03-15T12:00:00.000Z',
            title: null, summary: null,
            issuesJson: null, learningsJson: null,
          },
          {
            id: 2, branch: 'claude/recent', date: null,
            startedAt: '2026-04-16T12:00:00.000Z',
            title: null, summary: null,
            issuesJson: null, learningsJson: null,
          },
        ] as any,
      }) as any
    );

    const entries = await loadSessionLogsSince('2026-04-09');
    expect(entries).toHaveLength(1);
    expect(entries[0].branch).toBe('claude/recent');
  });

  it('drops rows where both date and startedAt are null', async () => {
    mockListAgentSessions.mockResolvedValue(
      apiOk({
        sessions: [
          {
            id: 1, branch: 'claude/broken',
            date: null, startedAt: null,
            title: null, summary: null,
            issuesJson: null, learningsJson: null,
          },
        ] as any,
      }) as any
    );

    const entries = await loadSessionLogsSince('2026-04-09');
    expect(entries).toHaveLength(0);
  });
});
