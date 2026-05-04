/**
 * Tests for session-finalize's QUA-1073 status promotion.
 *
 * Focus: the new conditional that sets `status: 'completed'` only
 * when both `title` and `summary` were extracted from the transcript.
 * Other branches of session-finalize (transcript discovery, dry-run,
 * server-availability, ID resolution) are out of scope here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  parseTranscriptMock,
  findLatestTranscriptMock,
  isServerAvailableMock,
  updateAgentSessionMock,
  getAgentSessionByBranchMock,
} = vi.hoisted(() => ({
  parseTranscriptMock: vi.fn(),
  findLatestTranscriptMock: vi.fn(() => '/tmp/fake-transcript.jsonl'),
  isServerAvailableMock: vi.fn(async () => true),
  updateAgentSessionMock: vi.fn(async () => ({ ok: true, data: {} })),
  getAgentSessionByBranchMock: vi.fn(async () => ({
    ok: true,
    data: { id: 477, status: 'active' as const },
  })),
}));

vi.mock('../lib/transcript-parser.ts', () => ({
  parseTranscript: parseTranscriptMock,
  findLatestTranscript: findLatestTranscriptMock,
}));

vi.mock('../lib/wiki-server/agent-sessions.ts', () => ({
  updateAgentSession: updateAgentSessionMock,
  getAgentSessionByBranch: getAgentSessionByBranchMock,
}));

vi.mock('../lib/wiki-server/client.ts', () => ({
  isServerAvailable: isServerAvailableMock,
}));

vi.mock('child_process', () => ({
  // session-finalize uses execSync for `git rev-parse` calls; return
  // a feature branch so the "no feature branch detected" guard
  // doesn't short-circuit.
  execSync: vi.fn((cmd: string) => {
    if (cmd.includes('--abbrev-ref')) return 'claude/qua-1073-fix\n';
    if (cmd.includes('--show-toplevel')) return '/tmp/fake-repo\n';
    return '';
  }),
}));

import { commands } from './session-finalize.ts';

beforeEach(() => {
  parseTranscriptMock.mockReset();
  isServerAvailableMock.mockReset();
  isServerAvailableMock.mockResolvedValue(true);
  updateAgentSessionMock.mockReset();
  updateAgentSessionMock.mockResolvedValue({ ok: true, data: {} });
  getAgentSessionByBranchMock.mockReset();
  getAgentSessionByBranchMock.mockResolvedValue({
    ok: true,
    data: { id: 477, status: 'active' },
  });
});

describe('session-finalize QUA-1073 status promotion', () => {
  it('sets status=completed when both title and summary are extracted', async () => {
    parseTranscriptMock.mockReturnValue({
      sessionId: 'abc',
      title: 'My session title',
      summary: 'Did some work',
      model: 'claude-opus-4-7',
      startedAt: '2026-05-03T10:00:00Z',
      endedAt: '2026-05-03T10:30:00Z',
      durationMinutes: 30,
      branch: 'claude/qua-1073-fix',
      lineCount: 42,
    });

    await commands.default([], {});

    expect(updateAgentSessionMock).toHaveBeenCalledTimes(1);
    const args = updateAgentSessionMock.mock.calls[0] as unknown as [number, Record<string, unknown>];
    const updates = args[1];
    expect(updates).toMatchObject({
      title: 'My session title',
      summary: 'Did some work',
      status: 'completed',
    });
  });

  it('does NOT set status when title is missing', async () => {
    parseTranscriptMock.mockReturnValue({
      sessionId: 'abc',
      title: null,
      summary: 'Did some work',
      model: 'claude-opus-4-7',
      startedAt: '2026-05-03T10:00:00Z',
      endedAt: '2026-05-03T10:30:00Z',
      durationMinutes: 30,
      branch: 'claude/qua-1073-fix',
      lineCount: 42,
    });

    await commands.default([], {});

    expect(updateAgentSessionMock).toHaveBeenCalledTimes(1);
    const args = updateAgentSessionMock.mock.calls[0] as unknown as [number, Record<string, unknown>];
    const updates = args[1];
    expect(updates.summary).toBe('Did some work');
    // Critical: status must NOT be set — the wiki-server endpoint
    // would reject the entire UPDATE due to incomplete_session
    // validation, rolling back the summary write too.
    expect(updates).not.toHaveProperty('status');
  });

  it('does NOT set status when summary is missing', async () => {
    parseTranscriptMock.mockReturnValue({
      sessionId: 'abc',
      title: 'My title',
      summary: null,
      model: 'claude-opus-4-7',
      startedAt: '2026-05-03T10:00:00Z',
      endedAt: '2026-05-03T10:30:00Z',
      durationMinutes: 30,
      branch: 'claude/qua-1073-fix',
      lineCount: 42,
    });

    await commands.default([], {});

    expect(updateAgentSessionMock).toHaveBeenCalledTimes(1);
    const args = updateAgentSessionMock.mock.calls[0] as unknown as [number, Record<string, unknown>];
    const updates = args[1];
    expect(updates.title).toBe('My title');
    expect(updates).not.toHaveProperty('status');
  });
});
