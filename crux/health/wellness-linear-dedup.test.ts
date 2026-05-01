/**
 * Tests for crux/health/wellness-linear-dedup.ts
 *
 * The dedup path is the critical piece of QUA-577 — if the search returns
 * a match, the caller MUST NOT create a new GitHub issue (which would
 * spawn another Linear duplicate). These tests exercise every branch:
 *
 *   - open match                 → comment, no create
 *   - recent closed              → reopen + comment, no create
 *   - recent closed + comment err → still "reopened" (critical — no fall-through)
 *   - stale closed               → fall through to create
 *   - no match                   → fall through to create
 *   - lookup error               → fall through (fail-open)
 *   - comment error (open path)  → fall through (fail-open)
 *   - reopen error               → fall through (fail-open)
 *   - unknown state type         → treated as closed (allowlist safety)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  dedupLinearWellnessIssue,
  createLinearWellnessIssue,
  closeLinearWellnessOnAllClear,
  isMissingLinearApiKeyError,
  REOPEN_WINDOW_MS,
  WELLNESS_PROJECT_NAME,
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
    const setState = vi.fn();

    const result = await dedupLinearWellnessIssue(TITLE, COMMENT, {
      search, comment, setState, now: () => NOW,
    });

    expect(result).toEqual({
      kind: 'commented',
      identifier: 'QUA-555',
      url: expect.any(String),
    });
    expect(comment).toHaveBeenCalledWith('QUA-555', COMMENT);
    expect(setState).not.toHaveBeenCalled();
  });

  it('filters out rows whose title does not exactly match', async () => {
    // Linear search is token-based, so a query for "System wellness check
    // failing" can return near-misses like "System wellness check flaky".
    // Those must NOT be treated as matches.
    const search = vi.fn().mockResolvedValue([
      makeIssue({ identifier: 'QUA-999', title: 'System wellness check flaky' }),
    ]);
    const comment = vi.fn();
    const setState = vi.fn();

    const result = await dedupLinearWellnessIssue(TITLE, COMMENT, {
      search, comment, setState, now: () => NOW,
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
    const setState = vi.fn().mockResolvedValue({ identifier: 'QUA-570', state: 'Backlog' });

    const result = await dedupLinearWellnessIssue(TITLE, COMMENT, {
      search, comment, setState, now: () => NOW,
    });

    expect(result).toEqual({
      kind: 'reopened',
      identifier: 'QUA-570',
      url: expect.any(String),
    });
    expect(setState).toHaveBeenCalledWith('QUA-570', 'Backlog');
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
    const setState = vi.fn();

    const result = await dedupLinearWellnessIssue(TITLE, COMMENT, {
      search, comment, setState, now: () => NOW,
    });

    expect(result).toEqual({ kind: 'skipped', reason: 'no-match' });
    expect(setState).not.toHaveBeenCalled();
    expect(comment).not.toHaveBeenCalled();
  });

  it('returns no-match when search returns an empty list', async () => {
    const search = vi.fn().mockResolvedValue([]);
    const comment = vi.fn();
    const setState = vi.fn();

    const result = await dedupLinearWellnessIssue(TITLE, COMMENT, {
      search, comment, setState, now: () => NOW,
    });

    expect(result).toEqual({ kind: 'skipped', reason: 'no-match' });
  });

  it('fails open when the Linear search throws', async () => {
    const search = vi.fn().mockRejectedValue(new Error('Linear GraphQL timed out'));
    const comment = vi.fn();
    const setState = vi.fn();

    const result = await dedupLinearWellnessIssue(TITLE, COMMENT, {
      search, comment, setState, now: () => NOW,
    });

    expect(result).toEqual({ kind: 'skipped', reason: 'lookup-failed' });
    expect(comment).not.toHaveBeenCalled();
    expect(setState).not.toHaveBeenCalled();
  });

  it('returns commented (NOT skipped) when commenting on an open match throws — prevents duplicate on open path', async () => {
    // The open ticket exists; its existence is the dedup signal. A failed
    // comment must NOT cascade into a GitHub create — that would mirror
    // into a second Linear ticket and reintroduce the duplicate cascade.
    const search = vi.fn().mockResolvedValue([
      makeIssue({ identifier: 'QUA-570', state: { name: 'In Progress', type: 'started' } }),
    ]);
    const comment = vi.fn().mockRejectedValue(new Error('Linear 5xx'));
    const setState = vi.fn();

    const result = await dedupLinearWellnessIssue(TITLE, COMMENT, {
      search, comment, setState, now: () => NOW,
    });

    expect(result).toEqual({
      kind: 'commented',
      identifier: 'QUA-570',
      url: expect.any(String),
    });
    expect(setState).not.toHaveBeenCalled();
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
    const setState = vi.fn().mockRejectedValue(new Error('state update refused'));

    const result = await dedupLinearWellnessIssue(TITLE, COMMENT, {
      search, comment, setState, now: () => NOW,
    });

    expect(result).toEqual({ kind: 'skipped', reason: 'lookup-failed' });
    expect(comment).not.toHaveBeenCalled();
  });

  it('returns reopened (NOT skipped) when reopen succeeds but comment throws — prevents the QUA-577 duplicate', async () => {
    // CRITICAL: if this returns `skipped/lookup-failed`, the caller in
    // wellness-report.ts falls through to createIssue, Linear's GitHub
    // integration mirrors that into ANOTHER Linear ticket, and we end up
    // with the reopened ticket PLUS a new duplicate — exactly the 8-in-57h
    // failure mode this entire module exists to prevent.
    const oneHourAgo = new Date(NOW - 60 * 60 * 1000).toISOString();
    const search = vi.fn().mockResolvedValue([
      makeIssue({
        identifier: 'QUA-570',
        state: { name: 'Done', type: 'completed' },
        updatedAt: oneHourAgo,
      }),
    ]);
    const comment = vi.fn().mockRejectedValue(new Error('Linear 500 on comment'));
    const setState = vi.fn().mockResolvedValue({ identifier: 'QUA-570', state: 'Backlog' });

    const result = await dedupLinearWellnessIssue(TITLE, COMMENT, {
      search, comment, setState, now: () => NOW,
    });

    expect(result).toEqual({
      kind: 'reopened',
      identifier: 'QUA-570',
      url: expect.any(String),
    });
    expect(setState).toHaveBeenCalledWith('QUA-570', 'Backlog');
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
    const setState = vi.fn();

    const result = await dedupLinearWellnessIssue(TITLE, COMMENT, {
      search, comment, setState, now: () => NOW,
    });

    expect(result).toEqual({
      kind: 'commented',
      identifier: 'QUA-400',
      url: expect.any(String),
    });
    expect(setState).not.toHaveBeenCalled();
  });

  it('returns skipped/misconfig (NOT skipped/lookup-failed) when LINEAR_API_KEY is missing', async () => {
    // QUA-676: discriminating misconfig from transient outage matters because
    // the caller stamps a banner on the GitHub issue body in the misconfig
    // case. If both errors were collapsed under `lookup-failed`, the caller
    // would treat a permanent missing-secret problem as a transient blip and
    // the duplicate cascade would keep happening invisibly.
    const apiKeyError = new Error(
      'LINEAR_API_KEY not set. Required for Linear API calls.\n' +
        'It should be in .env.base at the workspace root — sync it into the slot .env or export it.',
    );
    const search = vi.fn().mockRejectedValue(apiKeyError);
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const result = await dedupLinearWellnessIssue(TITLE, COMMENT, {
        search, comment: vi.fn(), setState: vi.fn(), now: () => NOW,
      });
      expect(result).toEqual({ kind: 'skipped', reason: 'misconfig' });
      // Loud failure is the whole point — assert the ::error annotation
      // pattern fires so this can't regress to a quiet warn.
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('::error title=Wellness dedup misconfigured::'),
      );
    } finally {
      consoleLogSpy.mockRestore();
    }
  });

  it('treats unknown state types as NOT open (allowlist safety)', async () => {
    // If Linear adds a new state type, we want to fail closed — better to
    // treat it as "already closed, maybe reopen" than to accidentally
    // comment on a ticket in an unknown state as if it were open.
    const oneHourAgo = new Date(NOW - 60 * 60 * 1000).toISOString();
    const search = vi.fn().mockResolvedValue([
      makeIssue({
        identifier: 'QUA-999',
        state: { name: 'Weird', type: 'some-future-type' },
        updatedAt: oneHourAgo,
      }),
    ]);
    const comment = vi.fn().mockResolvedValue(undefined);
    const setState = vi.fn().mockResolvedValue({ identifier: 'QUA-999', state: 'Backlog' });

    const result = await dedupLinearWellnessIssue(TITLE, COMMENT, {
      search, comment, setState, now: () => NOW,
    });

    // Unknown type is not open, so the code takes the closed-branch path:
    // setState('Backlog') runs before comment. If the allowlist regressed
    // to a denylist, the comment-only open-branch would fire instead and
    // setState would never be called.
    expect(result.kind).toBe('reopened');
    expect(setState).toHaveBeenCalledWith('QUA-999', 'Backlog');
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
    const setState = vi.fn().mockResolvedValue({ identifier: 'x', state: 'Done' });

    const result = await closeLinearWellnessOnAllClear(TITLE, closeComment, {
      search, comment, setState, now: () => NOW,
    });

    expect(result).toEqual({ kind: 'closed', identifiers: ['QUA-570', 'QUA-571'] });
    expect(setState).toHaveBeenCalledWith('QUA-570', 'Done');
    expect(setState).toHaveBeenCalledWith('QUA-571', 'Done');
    expect(setState).not.toHaveBeenCalledWith('QUA-555', expect.anything());
    // Comment must fire only for the open tickets, not the already-closed one.
    expect(comment).toHaveBeenCalledWith('QUA-570', closeComment);
    expect(comment).toHaveBeenCalledWith('QUA-571', closeComment);
    expect(comment).not.toHaveBeenCalledWith('QUA-555', expect.anything());
  });

  it('returns none when there are no open matches', async () => {
    const search = vi.fn().mockResolvedValue([
      makeIssue({ identifier: 'QUA-555', state: { name: 'Done', type: 'completed' } }),
    ]);

    const result = await closeLinearWellnessOnAllClear(TITLE, closeComment, {
      search,
      comment: vi.fn(),
      setState: vi.fn(),
      now: () => NOW,
    });

    expect(result).toEqual({ kind: 'none' });
  });

  it('returns lookup-failed when the search throws', async () => {
    const search = vi.fn().mockRejectedValue(new Error('Linear down'));

    const result = await closeLinearWellnessOnAllClear(TITLE, closeComment, {
      search,
      comment: vi.fn(),
      setState: vi.fn(),
      now: () => NOW,
    });

    expect(result).toEqual({ kind: 'lookup-failed' });
  });

  it('returns misconfig (NOT lookup-failed) when LINEAR_API_KEY is missing — and stays QUIET', async () => {
    // The all-clear path must not re-emit the loud ::error banner that the
    // failure path already emitted; otherwise every recovery cycle floods
    // the run summary with the same misconfig annotation. The failure path
    // is the canonical place to surface it.
    const apiKeyError = new Error('LINEAR_API_KEY not set. Required for Linear API calls.');
    const search = vi.fn().mockRejectedValue(apiKeyError);
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const result = await closeLinearWellnessOnAllClear(TITLE, closeComment, {
        search,
        comment: vi.fn(),
        setState: vi.fn(),
        now: () => NOW,
      });
      expect(result).toEqual({ kind: 'misconfig' });
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    } finally {
      consoleLogSpy.mockRestore();
      consoleWarnSpy.mockRestore();
    }
  });

  it('returns close-failed (NOT lookup-failed) when search succeeds but every close throws', async () => {
    // Discriminating search failure from close failure matters for telemetry —
    // the two failure modes have different root causes and different remediations.
    const search = vi.fn().mockResolvedValue([
      makeIssue({ identifier: 'QUA-570', state: { name: 'Backlog', type: 'backlog' } }),
      makeIssue({ identifier: 'QUA-571', state: { name: 'In Progress', type: 'started' } }),
    ]);
    const comment = vi.fn().mockRejectedValue(new Error('comment 500'));
    const setState = vi.fn();

    const result = await closeLinearWellnessOnAllClear(TITLE, closeComment, {
      search, comment, setState, now: () => NOW,
    });

    expect(result).toEqual({
      kind: 'close-failed',
      attempted: ['QUA-570', 'QUA-571'],
    });
  });

  it('returns closed with partial success when some closes throw', async () => {
    const search = vi.fn().mockResolvedValue([
      makeIssue({ identifier: 'QUA-570', state: { name: 'Backlog', type: 'backlog' } }),
      makeIssue({ identifier: 'QUA-571', state: { name: 'In Progress', type: 'started' } }),
    ]);
    const comment = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('second one failed'));
    const setState = vi.fn().mockResolvedValue({ identifier: 'x', state: 'Done' });

    const result = await closeLinearWellnessOnAllClear(TITLE, closeComment, {
      search, comment, setState, now: () => NOW,
    });

    expect(result).toEqual({ kind: 'closed', identifiers: ['QUA-570'] });
  });
});

describe('isMissingLinearApiKeyError', () => {
  it('matches the exact error thrown by getLinearApiKey()', () => {
    const err = new Error(
      'LINEAR_API_KEY not set. Required for Linear API calls.\n' +
        'It should be in .env.base at the workspace root — sync it into the slot .env or export it.',
    );
    expect(isMissingLinearApiKeyError(err)).toBe(true);
  });

  it('matches when the message is wrapped or quoted as a substring', () => {
    // Defensive: error wrapping (e.g., `new Error("upstream failed: " + e.message)`)
    // is a common pattern. Substring match keeps the detector robust against it.
    expect(isMissingLinearApiKeyError(new Error('upstream call failed: LINEAR_API_KEY not set'))).toBe(
      true,
    );
  });

  it('does not match generic Linear errors', () => {
    expect(isMissingLinearApiKeyError(new Error('Linear API returned 500'))).toBe(false);
    expect(isMissingLinearApiKeyError(new Error('fetch failed'))).toBe(false);
    expect(isMissingLinearApiKeyError(undefined)).toBe(false);
    expect(isMissingLinearApiKeyError(null)).toBe(false);
  });

  it('handles non-Error values (string thrown, etc.)', () => {
    // `throw "foo"` is unusual but legal in JS and would otherwise crash
    // the err.message access. The String(err) fallback covers it.
    expect(isMissingLinearApiKeyError('LINEAR_API_KEY not set in env')).toBe(true);
    expect(isMissingLinearApiKeyError({ toString: () => 'LINEAR_API_KEY not set yo' })).toBe(true);
  });
});

describe('createLinearWellnessIssue (QUA-970)', () => {
  const BODY = '## Wellness check failed\n\nSee details below.';

  it('creates a Linear ticket with the wellness project', async () => {
    const getProject = vi
      .fn()
      .mockResolvedValue({ id: 'project-uuid-aaaa', name: WELLNESS_PROJECT_NAME });
    const createIssue = vi
      .fn()
      .mockResolvedValue({ identifier: 'QUA-9999', url: 'https://linear.app/q/issue/QUA-9999' });

    const result = await createLinearWellnessIssue(TITLE, BODY, { getProject, createIssue });

    expect(result).toEqual({
      kind: 'created',
      identifier: 'QUA-9999',
      url: 'https://linear.app/q/issue/QUA-9999',
    });
    // Project lookup is the load-bearing piece — without it we'd file a
    // projectless orphan, which is exactly the leak this migration closes.
    expect(getProject).toHaveBeenCalledWith(WELLNESS_PROJECT_NAME);
    expect(createIssue).toHaveBeenCalledWith({
      title: TITLE,
      description: BODY,
      projectId: 'project-uuid-aaaa',
    });
  });

  it('returns failed/misconfig when LINEAR_API_KEY is missing during project lookup', async () => {
    const apiKeyError = new Error('LINEAR_API_KEY not set. Required for Linear API calls.');
    const getProject = vi.fn().mockRejectedValue(apiKeyError);
    const createIssue = vi.fn();

    const result = await createLinearWellnessIssue(TITLE, BODY, { getProject, createIssue });

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.reason).toBe('misconfig');
    // Critical: the create call must NOT have been attempted without a valid key.
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('returns failed/misconfig when LINEAR_API_KEY is missing during create call', async () => {
    // Possible if the project lookup is mocked or cached but the create still hits the API.
    const apiKeyError = new Error('LINEAR_API_KEY not set');
    const getProject = vi
      .fn()
      .mockResolvedValue({ id: 'project-uuid-aaaa', name: WELLNESS_PROJECT_NAME });
    const createIssue = vi.fn().mockRejectedValue(apiKeyError);

    const result = await createLinearWellnessIssue(TITLE, BODY, { getProject, createIssue });

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.reason).toBe('misconfig');
  });

  it('returns failed/project-missing when the project name does not resolve', async () => {
    // Exercises the rename-detection path — if someone renames the project in
    // Linear, we surface it loudly instead of silently filing a projectless
    // ticket. The fallback behavior in the caller is to drop to GitHub.
    const getProject = vi.fn().mockResolvedValue(null);
    const createIssue = vi.fn();

    const result = await createLinearWellnessIssue(TITLE, BODY, { getProject, createIssue });

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.reason).toBe('project-missing');
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('returns failed/api-error on a transient Linear outage during create', async () => {
    const getProject = vi
      .fn()
      .mockResolvedValue({ id: 'project-uuid-aaaa', name: WELLNESS_PROJECT_NAME });
    const createIssue = vi.fn().mockRejectedValue(new Error('Linear 503'));

    const result = await createLinearWellnessIssue(TITLE, BODY, { getProject, createIssue });

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.reason).toBe('api-error');
  });

  it('returns failed/api-error on a transient Linear outage during project lookup', async () => {
    const getProject = vi.fn().mockRejectedValue(new Error('Linear 503'));
    const createIssue = vi.fn();

    const result = await createLinearWellnessIssue(TITLE, BODY, { getProject, createIssue });

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.reason).toBe('api-error');
    expect(createIssue).not.toHaveBeenCalled();
  });
});
