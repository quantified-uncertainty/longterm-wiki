/**
 * Tests for the dedup helpers used by `crux linear start`. Covers the
 * pure filtering logic: what counts as an "active claim by another
 * session" vs a stale / same-slot / released claim.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionContext } from '../session/session-context.ts';

const { getCommentsMock, githubApiMock, getAgentSessionsByLinearIdMock } = vi.hoisted(() => ({
  getCommentsMock: vi.fn(),
  githubApiMock: vi.fn(),
  getAgentSessionsByLinearIdMock: vi.fn(),
}));

vi.mock('./issues.ts', () => ({
  getComments: getCommentsMock,
}));

vi.mock('../github.ts', () => ({
  githubApi: githubApiMock,
  REPO: 'quantified-uncertainty/longterm-wiki',
}));

vi.mock('../wiki-server/agent-sessions.ts', () => ({
  getAgentSessionsByLinearId: getAgentSessionsByLinearIdMock,
}));

import {
  findActiveClaimsByOthers,
  findOpenPrsMentioningLinearId,
} from './dedup.ts';

const now = Date.parse('2026-04-13T22:00:00Z');

function startComment(opts: {
  slot?: string;
  branch?: string;
  hoursAgo: number;
  id?: string;
}) {
  const lines = ['🤖 Claude Code starting work on this issue.', ''];
  if (opts.slot) lines.push(`**Slot:** ${opts.slot}`);
  if (opts.branch) lines.push(`**Branch:** \`${opts.branch}\``);
  return {
    id: opts.id ?? `c-${Math.random()}`,
    body: lines.join('\n'),
    createdAt: new Date(now - opts.hoursAgo * 60 * 60 * 1000).toISOString(),
    user: { name: 'bot' },
  };
}

function finishComment(hoursAgo: number) {
  return {
    id: `c-fin-${Math.random()}`,
    body: '🤖 Claude Code finished work on this issue.',
    createdAt: new Date(now - hoursAgo * 60 * 60 * 1000).toISOString(),
    user: { name: 'bot' },
  };
}

const baseCtx: SessionContext = {
  slot: 5,
  branch: 'claude/qua-406-linear-start-dedup',
  host: 'test-host',
  agentId: null,
};

beforeEach(() => {
  getCommentsMock.mockReset();
  githubApiMock.mockReset();
  getAgentSessionsByLinearIdMock.mockReset();
  // Default: PG query "fails open" (returns null) so existing tests (which
  // pre-date the PG path) keep testing the Linear-comment fallback.
  getAgentSessionsByLinearIdMock.mockResolvedValue({ ok: false });
});

describe('findActiveClaimsByOthers', () => {
  it('returns empty when there are no comments', async () => {
    getCommentsMock.mockResolvedValueOnce([]);
    const claims = await findActiveClaimsByOthers('QUA-406', baseCtx, now);
    expect(claims).toEqual([]);
  });

  it('returns empty when the only start comment is from our own slot', async () => {
    getCommentsMock.mockResolvedValueOnce([
      startComment({ slot: 'a5', branch: 'claude/qua-406-earlier', hoursAgo: 2 }),
    ]);
    const claims = await findActiveClaimsByOthers('QUA-406', baseCtx, now);
    expect(claims).toEqual([]);
  });

  it('flags a recent start comment from a different slot', async () => {
    getCommentsMock.mockResolvedValueOnce([
      startComment({ slot: 'a9', branch: 'claude/qua-406-other', hoursAgo: 2 }),
    ]);
    const claims = await findActiveClaimsByOthers('QUA-406', baseCtx, now);
    expect(claims).toHaveLength(1);
    expect(claims[0].slot).toBe('a9');
    expect(claims[0].branch).toBe('claude/qua-406-other');
  });

  it('ignores start comments older than 24h', async () => {
    getCommentsMock.mockResolvedValueOnce([
      startComment({ slot: 'a9', branch: 'claude/qua-406-old', hoursAgo: 36 }),
    ]);
    const claims = await findActiveClaimsByOthers('QUA-406', baseCtx, now);
    expect(claims).toEqual([]);
  });

  it('treats a later finish comment as releasing prior start claims', async () => {
    getCommentsMock.mockResolvedValueOnce([
      startComment({ slot: 'a9', branch: 'claude/qua-406-done', hoursAgo: 3 }),
      finishComment(2),
    ]);
    const claims = await findActiveClaimsByOthers('QUA-406', baseCtx, now);
    expect(claims).toEqual([]);
  });

  it('keeps a start claim posted AFTER the finish comment', async () => {
    getCommentsMock.mockResolvedValueOnce([
      startComment({ slot: 'a9', branch: 'claude/qua-406-done', hoursAgo: 5 }),
      finishComment(4),
      startComment({ slot: 'a9', branch: 'claude/qua-406-restart', hoursAgo: 1 }),
    ]);
    const claims = await findActiveClaimsByOthers('QUA-406', baseCtx, now);
    expect(claims).toHaveLength(1);
    expect(claims[0].branch).toBe('claude/qua-406-restart');
  });

  it('fails open when getComments throws', async () => {
    getCommentsMock.mockRejectedValueOnce(new Error('Linear unreachable'));
    const claims = await findActiveClaimsByOthers('QUA-406', baseCtx, now);
    expect(claims).toEqual([]);
  });

  it('handles start comments missing slot/branch fields gracefully', async () => {
    getCommentsMock.mockResolvedValueOnce([
      {
        id: 'c1',
        body: '🤖 Claude Code starting work on this issue.',
        createdAt: new Date(now - 60 * 60 * 1000).toISOString(),
        user: { name: 'bot' },
      },
    ]);
    // Orphan claims (no slot) from a slot-less caller are ignored — too
    // ambiguous to block on. A slot-ful caller treats them as collisions.
    const claims = await findActiveClaimsByOthers('QUA-406', baseCtx, now);
    expect(claims).toHaveLength(1); // slot-ful caller treats as collision
  });

  // ── PG-first (QUA-440) ────────────────────────────────────────────────

  describe('PG-first (QUA-440)', () => {
    it('uses PG when it returns cross-slot active sessions, skipping Linear', async () => {
      getAgentSessionsByLinearIdMock.mockResolvedValueOnce({
        ok: true,
        data: {
          sessions: [
            {
              id: 1,
              branch: 'claude/qua-406-other',
              slotNumber: 9,
              status: 'active',
              updatedAt: new Date(now - 5 * 60 * 1000).toISOString(),
              linearId: 'QUA-406',
              task: 'other session',
            },
          ],
          freshMinutes: 30,
        },
      });
      const claims = await findActiveClaimsByOthers('QUA-406', baseCtx, now);
      expect(claims).toHaveLength(1);
      expect(claims[0].slot).toBe('a9');
      expect(claims[0].branch).toBe('claude/qua-406-other');
      // Linear comments should NOT have been consulted.
      expect(getCommentsMock).not.toHaveBeenCalled();
    });

    it('filters out same-slot sessions (session resumption, not collision)', async () => {
      getAgentSessionsByLinearIdMock.mockResolvedValueOnce({
        ok: true,
        data: {
          sessions: [
            {
              id: 1,
              branch: 'claude/qua-406-linear-start-dedup',
              slotNumber: 5,
              status: 'active',
              updatedAt: new Date(now - 5 * 60 * 1000).toISOString(),
              linearId: 'QUA-406',
              task: 'same slot resume',
            },
          ],
          freshMinutes: 30,
        },
      });
      // PG says "no cross-slot claims" → fall through to Linear, which is
      // empty → return []. The same-slot session is not a collision.
      getCommentsMock.mockResolvedValueOnce([]);
      const claims = await findActiveClaimsByOthers('QUA-406', baseCtx, now);
      expect(claims).toEqual([]);
    });

    it('filters out same-branch sessions even when slot is unset', async () => {
      const slotlessCtx: SessionContext = { ...baseCtx, slot: null };
      getAgentSessionsByLinearIdMock.mockResolvedValueOnce({
        ok: true,
        data: {
          sessions: [
            {
              id: 1,
              branch: slotlessCtx.branch,
              slotNumber: 9,
              status: 'active',
              updatedAt: new Date(now - 5 * 60 * 1000).toISOString(),
              linearId: 'QUA-406',
              task: 'same branch, different slot (e.g. re-init)',
            },
          ],
          freshMinutes: 30,
        },
      });
      getCommentsMock.mockResolvedValueOnce([]);
      const claims = await findActiveClaimsByOthers('QUA-406', slotlessCtx, now);
      expect(claims).toEqual([]);
    });

    it('falls through to Linear when PG returns an empty result', async () => {
      getAgentSessionsByLinearIdMock.mockResolvedValueOnce({
        ok: true,
        data: { sessions: [], freshMinutes: 30 },
      });
      getCommentsMock.mockResolvedValueOnce([
        startComment({ slot: 'a9', branch: 'claude/qua-406-from-linear', hoursAgo: 2 }),
      ]);
      const claims = await findActiveClaimsByOthers('QUA-406', baseCtx, now);
      expect(claims).toHaveLength(1);
      expect(claims[0].branch).toBe('claude/qua-406-from-linear');
      expect(getCommentsMock).toHaveBeenCalledTimes(1);
    });

    it('falls through to Linear when PG is unreachable (ok: false)', async () => {
      getAgentSessionsByLinearIdMock.mockResolvedValueOnce({ ok: false });
      getCommentsMock.mockResolvedValueOnce([
        startComment({ slot: 'a9', branch: 'claude/qua-406-from-linear', hoursAgo: 2 }),
      ]);
      const claims = await findActiveClaimsByOthers('QUA-406', baseCtx, now);
      expect(claims).toHaveLength(1);
    });

    it('falls through to Linear when PG throws', async () => {
      getAgentSessionsByLinearIdMock.mockRejectedValueOnce(
        new Error('wiki-server unreachable'),
      );
      getCommentsMock.mockResolvedValueOnce([
        startComment({ slot: 'a9', branch: 'claude/qua-406-from-linear', hoursAgo: 2 }),
      ]);
      const claims = await findActiveClaimsByOthers('QUA-406', baseCtx, now);
      expect(claims).toHaveLength(1);
    });
  });
});

describe('findOpenPrsMentioningLinearId', () => {
  it('returns empty on no matches', async () => {
    githubApiMock.mockResolvedValueOnce({ items: [] });
    const prs = await findOpenPrsMentioningLinearId('QUA-406');
    expect(prs).toEqual([]);
  });

  it('returns PRs whose title or body mentions the ID', async () => {
    githubApiMock.mockResolvedValueOnce({
      items: [
        {
          number: 4296,
          title: 'fix: raw ID leaks (QUA-406)',
          html_url: 'https://github.com/x/y/pull/4296',
          body: 'Fixes QUA-406',
          pull_request: {},
        },
      ],
    });
    const prs = await findOpenPrsMentioningLinearId('QUA-406');
    expect(prs).toHaveLength(1);
    expect(prs[0].number).toBe(4296);
    expect(prs[0].url).toBe('https://github.com/x/y/pull/4296');
  });

  it('filters out issues (non-PR results from /search/issues)', async () => {
    githubApiMock.mockResolvedValueOnce({
      items: [
        {
          number: 100,
          title: 'bug: QUA-406 unrelated',
          html_url: 'https://github.com/x/y/issues/100',
          body: 'QUA-406 is mentioned but this is an issue',
          // no pull_request field
        },
        {
          number: 4296,
          title: 'fix: QUA-406',
          html_url: 'https://github.com/x/y/pull/4296',
          body: '',
          pull_request: {},
        },
      ],
    });
    const prs = await findOpenPrsMentioningLinearId('QUA-406');
    expect(prs).toHaveLength(1);
    expect(prs[0].number).toBe(4296);
  });

  it('filters out weak matches where the ID is not a word boundary', async () => {
    githubApiMock.mockResolvedValueOnce({
      items: [
        {
          number: 1,
          title: 'prefix QUA-4069 suffix', // QUA-406 is NOT a substring hit
          html_url: 'https://github.com/x/y/pull/1',
          body: '',
          pull_request: {},
        },
      ],
    });
    const prs = await findOpenPrsMentioningLinearId('QUA-406');
    expect(prs).toEqual([]);
  });

  it('fails open when githubApi throws', async () => {
    githubApiMock.mockRejectedValueOnce(new Error('rate limit exceeded'));
    const prs = await findOpenPrsMentioningLinearId('QUA-406');
    expect(prs).toEqual([]);
  });
});
