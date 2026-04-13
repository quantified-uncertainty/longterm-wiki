/**
 * Tests for the dedup helpers used by `crux linear start`. Covers the
 * pure filtering logic: what counts as an "active claim by another
 * session" vs a stale / same-slot / released claim.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionContext } from '../session/session-context.ts';

const { getCommentsMock, githubApiMock } = vi.hoisted(() => ({
  getCommentsMock: vi.fn(),
  githubApiMock: vi.fn(),
}));

vi.mock('./issues.ts', () => ({
  getComments: getCommentsMock,
}));

vi.mock('../github.ts', () => ({
  githubApi: githubApiMock,
  REPO: 'quantified-uncertainty/longterm-wiki',
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
