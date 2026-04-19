/**
 * Tests for crux/health/wellness-linear-dedup.ts
 *
 * The dedup path is the critical piece of QUA-577 — if the search returns
 * a match, the caller MUST NOT create a new GitHub issue (which would
 * spawn another Linear duplicate). These tests exercise every branch:
 *
 *   - open match      → comment, no create
 *   - recent closed   → reopen + comment, no create
 *   - stale closed    → fall through to create
 *   - no match        → fall through to create
 *   - lookup error    → fall through (fail-open)
 *   - comment error   → fall through (fail-open)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  dedupLinearWellnessIssue,
  closeLinearWellnessOnAllClear,
  REOPEN_WINDOW_MS,
} from './wellness-linear-dedup.ts';
import type { SearchedIssue } from '../lib/linear/issues.ts';

const TITLE = 'System wellness check failing';
const COMMENT = 'Wellness check failing again at 2026-04-19 20:00 UTC.';

// Fixed reference point for deterministic "now" in tests
const NOW = Date.parse('2026-04-19T20:00:00.000Z');

function makeIssue(overrides: Partial<SearchedIssue> = {}): SearchedIssue {
  return {
    identifier: 'QUA-500',
    title: TITLE,
    priority: 0,
    state: { name: 'Backlog', type: 'backlog' },
    url: 'https://linear.app/quantifieduncertainty/issue/QUA-500',
    createdAt: new Date(NOW - 3_600_000).toISOString(),
    updatedAt: new Date(NOW - 3_600_000).toISOString(),
    ...overrides,
  };
}

describe('dedupLinearWellnessIssue', () => {
  it('comments on the oldest open match and returns commented', async () => {
    const search = vi.fn().mockResolvedValue([
      makeIssue({ identifier: 'QUA-570', state: { name: 'Backlog', type: 'backlog' } }),
      makeIssue({ identifier: 'QUA-555', state: { name: 'Backlog', type: 'backlog' } }),
    ]);
    const comment = vi.fn().mockResolvedValue(undefined);
    const reopen = vi.fn().mockResolvedValue({ identifier: 'x', state: 'Backlog' });

    const result = await dedupLinearWellnessIssue(TITLE, COMMENT, {
      search, comment, reopen, now: () => NOW,
    });

    expect(result).toEqual({
      kind: 'commented',
      identifier: 'QUA-555',
      url: expect.any(String),
    });
    expect(comment).toHaveBeenCalledWith('QUA-555', COMMENT);
    expect(reopen).not.toHaveBeenCalled();
  });

  it('filters out rows whose title does not exactly match', async () => {
    // Linear search is token-based, so a query for "System wellness check
    // failing" can return near-misses like "System wellness check flaky".
    // Those must NOT be treated as matches.
    const search = vi.fn().mockResolvedValue([
      makeIssue({ identifier: 'QUA-999', title: 'System wellness check flaky' }),
    ]);
    const comment = vi.fn();
    const reopen = vi.fn();

    const result = await dedupLinearWellnessIssue(TITLE, COMMENT, {
      search, comment, reopen, now: () => NOW,
    });

    expect(result).toEqual({ kind: 'skipped', reason: 'no-match' });
    expect(comment).not.toHaveBeenCalled();
  });

  it('reopens the most recently closed match when inside the reopen window', async () => {
    const oneHourAgo = new Date(NOW - 60 * 60 * 1000).toISOString();
    const tenHoursAgo = new Date(NOW - 10 * 60 * 60 * 1000).toISOString();
    const search = vi.fn().mockResolvedValue([
      makeIssue({
        identifier: 'QUA-555',
        state: { name: 'Done', type: 'completed' },
        updatedAt: tenHoursAgo,
      }),
      makeIssue({
        identifier: 'QUA-570',
        state: { name: 'Done', type: 'completed' },
        updatedAt: oneHourAgo,
      }),
    ]);
    const comment = vi.fn().mockResolvedValue(undefined);
    const reopen = vi.fn().mockResolvedValue({ identifier: 'QUA-570', state: 'Backlog' });

    const result = await dedupLinearWellnessIssue(TITLE, COMMENT, {
      search, comment, reopen, now: () => NOW,
    });

    expect(result).toEqual({
      kind: 'reopened',
      identifier: 'QUA-570',
      url: expect.any(String),
    });
    expect(reopen).toHaveBeenCalledWith('QUA-570', 'Backlog');
    expect(comment).toHaveBeenCalledWith('QUA-570', COMMENT);
  });

  it('skips reopening when the newest closed match is outside the reopen window', async () => {
    const outsideWindow = new Date(NOW - REOPEN_WINDOW_MS - 60_000).toISOString();
    const search = vi.fn().mockResolvedValue([
      makeIssue({
        identifier: 'QUA-400',
        state: { name: 'Done', type: 'completed' },
        updatedAt: outsideWindow,
      }),
    ]);
    const comment = vi.fn();
    const reopen = vi.fn();

    const result = await dedupLinearWellnessIssue(TITLE, COMMENT, {
      search, comment, reopen, now: () => NOW,
    });

    expect(result).toEqual({ kind: 'skipped', reason: 'no-match' });
    expect(reopen).not.toHaveBeenCalled();
    expect(comment).not.toHaveBeenCalled();
  });

  it('returns no-match when search returns an empty list', async () => {
    const search = vi.fn().mockResolvedValue([]);
    const comment = vi.fn();
    const reopen = vi.fn();

    const result = await dedupLinearWellnessIssue(TITLE, COMMENT, {
      search, comment, reopen, now: () => NOW,
    });

    expect(result).toEqual({ kind: 'skipped', reason: 'no-match' });
  });

  it('fails open when the Linear search throws', async () => {
    const search = vi.fn().mockRejectedValue(new Error('Linear GraphQL timed out'));
    const comment = vi.fn();
    const reopen = vi.fn();

    const result = await dedupLinearWellnessIssue(TITLE, COMMENT, {
      search, comment, reopen, now: () => NOW,
    });

    expect(result).toEqual({ kind: 'skipped', reason: 'lookup-failed' });
    expect(comment).not.toHaveBeenCalled();
    expect(reopen).not.toHaveBeenCalled();
  });

  it('fails open when commenting on an open match throws', async () => {
    const search = vi.fn().mockResolvedValue([
      makeIssue({ identifier: 'QUA-570', state: { name: 'In Progress', type: 'started' } }),
    ]);
    const comment = vi.fn().mockRejectedValue(new Error('Linear 5xx'));
    const reopen = vi.fn();

    const result = await dedupLinearWellnessIssue(TITLE, COMMENT, {
      search, comment, reopen, now: () => NOW,
    });

    expect(result).toEqual({ kind: 'skipped', reason: 'lookup-failed' });
    expect(reopen).not.toHaveBeenCalled();
  });

  it('fails open when the reopen state transition throws', async () => {
    const oneHourAgo = new Date(NOW - 60 * 60 * 1000).toISOString();
    const search = vi.fn().mockResolvedValue([
      makeIssue({
        identifier: 'QUA-570',
        state: { name: 'Done', type: 'completed' },
        updatedAt: oneHourAgo,
      }),
    ]);
    const comment = vi.fn();
    const reopen = vi.fn().mockRejectedValue(new Error('state update refused'));

    const result = await dedupLinearWellnessIssue(TITLE, COMMENT, {
      search, comment, reopen, now: () => NOW,
    });

    expect(result).toEqual({ kind: 'skipped', reason: 'lookup-failed' });
  });

  it('prefers the open match even when a recent closed match also exists', async () => {
    // Regression: an old, open ticket in Backlog should win over a freshly
    // closed one — Linear's dedup ordering must match GitHub's "keep the
    // original" convention (oldest open) or the two systems diverge on
    // which ticket is canonical.
    const oneHourAgo = new Date(NOW - 60 * 60 * 1000).toISOString();
    const search = vi.fn().mockResolvedValue([
      makeIssue({
        identifier: 'QUA-400',
        state: { name: 'Backlog', type: 'backlog' },
      }),
      makeIssue({
        identifier: 'QUA-555',
        state: { name: 'Done', type: 'completed' },
        updatedAt: oneHourAgo,
      }),
    ]);
    const comment = vi.fn().mockResolvedValue(undefined);
    const reopen = vi.fn();

    const result = await dedupLinearWellnessIssue(TITLE, COMMENT, {
      search, comment, reopen, now: () => NOW,
    });

    expect(result).toEqual({
      kind: 'commented',
      identifier: 'QUA-400',
      url: expect.any(String),
    });
    expect(reopen).not.toHaveBeenCalled();
  });
});

describe('closeLinearWellnessOnAllClear', () => {
  const closeComment = 'All wellness checks passed at 2026-04-19 20:00 UTC. Auto-closing.';

  it('closes every open match and returns their identifiers', async () => {
    const search = vi.fn().mockResolvedValue([
      makeIssue({ identifier: 'QUA-570', state: { name: 'Backlog', type: 'backlog' } }),
      makeIssue({ identifier: 'QUA-555', state: { name: 'Done', type: 'completed' } }),
      makeIssue({ identifier: 'QUA-571', state: { name: 'In Progress', type: 'started' } }),
    ]);
    const comment = vi.fn().mockResolvedValue(undefined);
    const reopen = vi.fn().mockResolvedValue({ identifier: 'x', state: 'Done' });

    const result = await closeLinearWellnessOnAllClear(TITLE, closeComment, {
      search, comment, reopen, now: () => NOW,
    });

    expect(result).toEqual({ kind: 'closed', identifiers: ['QUA-570', 'QUA-571'] });
    expect(reopen).toHaveBeenCalledWith('QUA-570', 'Done');
    expect(reopen).toHaveBeenCalledWith('QUA-571', 'Done');
    expect(reopen).not.toHaveBeenCalledWith('QUA-555', expect.anything());
  });

  it('returns none when there are no open matches', async () => {
    const search = vi.fn().mockResolvedValue([
      makeIssue({ identifier: 'QUA-555', state: { name: 'Done', type: 'completed' } }),
    ]);

    const result = await closeLinearWellnessOnAllClear(TITLE, closeComment, {
      search,
      comment: vi.fn(),
      reopen: vi.fn(),
      now: () => NOW,
    });

    expect(result).toEqual({ kind: 'none' });
  });

  it('returns lookup-failed when the search throws', async () => {
    const search = vi.fn().mockRejectedValue(new Error('Linear down'));

    const result = await closeLinearWellnessOnAllClear(TITLE, closeComment, {
      search,
      comment: vi.fn(),
      reopen: vi.fn(),
      now: () => NOW,
    });

    expect(result).toEqual({ kind: 'lookup-failed' });
  });
});
