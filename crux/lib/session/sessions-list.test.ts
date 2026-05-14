/**
 * Unit tests for the cross-session observability merge/filter/format logic
 * underneath `crux sys sessions list` (QUA-413).
 */

import { describe, it, expect } from 'vitest';
import {
  mergeSessions,
  filterSessions,
  sortSessions,
  toDisplayRow,
  formatAge,
  formatPr,
  truncate,
  type MergedSession,
} from './sessions-list.ts';
import type { AgentSessionListResponse } from '../wiki-server/agent-sessions.ts';
import type { ClaudeProcess } from './claude-processes.ts';

type DbSession = AgentSessionListResponse['sessions'][number];

const NOW = new Date('2026-04-18T20:30:00Z').getTime();

function mkSession(partial: Partial<DbSession>): DbSession {
  // Build a minimal row with the columns our code actually reads. Other
  // fields are present in the real response but unused here — we cast so
  // the test helpers don't need to enumerate every nullable column.
  return {
    id: 1,
    branch: 'main',
    task: 'do the thing',
    sessionType: 'infrastructure',
    issueNumber: null,
    linearId: null,
    slotNumber: null,
    worktree: null,
    prUrl: null,
    prOutcome: null,
    fixesPrUrl: null,
    checklistMd: '',
    status: 'active',
    startedAt: new Date(NOW - 60 * 60_000).toISOString(),
    completedAt: null,
    createdAt: new Date(NOW - 60 * 60_000).toISOString(),
    updatedAt: new Date(NOW - 1 * 60_000).toISOString(),
    heartbeatAt: new Date(NOW - 1 * 60_000).toISOString(),
    date: null,
    title: null,
    summary: null,
    model: null,
    duration: null,
    durationMinutes: null,
    cost: null,
    costCents: null,
    checksYaml: null,
    issuesJson: null,
    learningsJson: null,
    recommendationsJson: null,
    reviewed: null,
    ...partial,
  } as DbSession;
}

describe('mergeSessions — liveness classification', () => {
  it('classifies heartbeat <2min as live', () => {
    const s = mkSession({
      id: 1,
      slotNumber: 9,
      heartbeatAt: new Date(NOW - 30_000).toISOString(),
    });
    const [row] = mergeSessions([s], [], { now: NOW });
    expect(row.liveness).toBe('live');
  });

  it('classifies heartbeat between 2 and 30 min as recent', () => {
    const s = mkSession({
      id: 1,
      heartbeatAt: new Date(NOW - 10 * 60_000).toISOString(),
    });
    const [row] = mergeSessions([s], [], { now: NOW });
    expect(row.liveness).toBe('recent');
  });

  it('classifies active rows with heartbeat >30min as stale', () => {
    const s = mkSession({
      id: 1,
      status: 'active',
      heartbeatAt: new Date(NOW - 60 * 60_000).toISOString(),
      updatedAt: new Date(NOW - 60 * 60_000).toISOString(),
    });
    const [row] = mergeSessions([s], [], { now: NOW });
    expect(row.liveness).toBe('stale');
  });

  it('classifies completed rows as done regardless of heartbeat freshness', () => {
    const s = mkSession({
      id: 1,
      status: 'completed',
      heartbeatAt: new Date(NOW - 30_000).toISOString(),
    });
    const [row] = mergeSessions([s], [], { now: NOW });
    expect(row.liveness).toBe('done');
  });

  it('falls back to updatedAt when heartbeatAt is null', () => {
    const s = mkSession({
      id: 1,
      heartbeatAt: null,
      updatedAt: new Date(NOW - 30_000).toISOString(),
    });
    const [row] = mergeSessions([s], [], { now: NOW });
    expect(row.liveness).toBe('live');
  });

  it('classifies rows with no timestamp at all as stale', () => {
    const s = mkSession({
      id: 1,
      heartbeatAt: null,
      updatedAt: null as unknown as string,
    });
    const [row] = mergeSessions([s], [], { now: NOW });
    expect(row.liveness).toBe('stale');
    expect(row.ageMinutes).toBeNull();
  });

  it('respects custom liveMinutes and staleMinutes thresholds', () => {
    const s = mkSession({
      id: 1,
      heartbeatAt: new Date(NOW - 5 * 60_000).toISOString(),
    });
    const [row] = mergeSessions([s], [], {
      now: NOW,
      liveMinutes: 10,
      staleMinutes: 20,
    });
    expect(row.liveness).toBe('live'); // 5 min ago is within a 10-min live window
  });
});

describe('mergeSessions — process correlation', () => {
  it('matches a live claude process to a DB session by slot number', () => {
    const s = mkSession({ id: 1, slotNumber: 9 });
    const p: ClaudeProcess = { pid: 95223, cwd: '/lw/a9', slot: 9 };
    const [row] = mergeSessions([s], [p], { now: NOW });
    expect(row.process).toEqual(p);
  });

  it('emits a ghost row when a live claude process has no DB session', () => {
    const p: ClaudeProcess = { pid: 42, cwd: '/lw/a15', slot: 15 };
    const rows = mergeSessions([], [p], { now: NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0].liveness).toBe('ghost');
    expect(rows[0].session).toBeNull();
    expect(rows[0].process).toBe(p);
  });

  it('does NOT emit a ghost when the process slot matches an active DB session', () => {
    const s = mkSession({ id: 1, slotNumber: 9 });
    const p: ClaudeProcess = { pid: 42, cwd: '/lw/a9', slot: 9 };
    const rows = mergeSessions([s], [p], { now: NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0].session?.id).toBe(1);
    expect(rows[0].process).toEqual(p);
  });

  it('ignores processes with null slot for ghost detection', () => {
    const p: ClaudeProcess = { pid: 42, cwd: '/tmp', slot: null };
    const rows = mergeSessions([], [p], { now: NOW });
    expect(rows).toEqual([]);
  });

  it('handles multiple processes in the same slot: first binds to session, rest become ghosts', () => {
    const s = mkSession({ id: 1, slotNumber: 9 });
    const p1: ClaudeProcess = { pid: 10, cwd: '/lw/a9', slot: 9 };
    const p2: ClaudeProcess = { pid: 20, cwd: '/lw/a9', slot: 9 };
    const rows = mergeSessions([s], [p1, p2], { now: NOW });
    // p1 binds to the session; p2 surfaces as a ghost so the
    // "is anyone else using this slot?" signal isn't lost.
    expect(rows).toHaveLength(2);
    expect(rows[0].session?.id).toBe(1);
    expect(rows[0].process?.pid).toBe(10);
    expect(rows[1].session).toBeNull();
    expect(rows[1].liveness).toBe('ghost');
    expect(rows[1].process?.pid).toBe(20);
  });
});

describe('mergeSessions — defensive option validation', () => {
  it('falls back to default liveMinutes on NaN / negative / zero input', () => {
    const s = mkSession({
      id: 1,
      heartbeatAt: new Date(NOW - 30_000).toISOString(), // 30s ago → live (<2m)
    });
    for (const bad of [NaN, -5, 0, Infinity as unknown as number]) {
      const [row] = mergeSessions([s], [], {
        now: NOW,
        liveMinutes: bad,
      });
      // Without NaN-guarding, `age < NaN` is false and liveness would be "stale".
      // With the guard, default (2m) is used and age=30s classifies as live.
      expect(row.liveness).toBe('live');
    }
  });
});

describe('filterSessions', () => {
  const sessions: MergedSession[] = [
    {
      session: mkSession({ id: 1, slotNumber: 9, linearId: 'QUA-413' }),
      process: null,
      liveness: 'recent',
      ageMinutes: 5,
    },
    {
      session: mkSession({ id: 2, slotNumber: 10, linearId: 'QUA-500' }),
      process: null,
      liveness: 'done',
      ageMinutes: 60,
    },
    {
      session: null,
      process: { pid: 1, cwd: '/lw/a11', slot: 11 },
      liveness: 'ghost',
      ageMinutes: null,
    },
  ];

  it('drops completed sessions by default', () => {
    const r = filterSessions(sessions, {});
    expect(r.map((s) => s.session?.id ?? 'ghost')).toEqual([1, 'ghost']);
  });

  it('keeps completed sessions when includeCompleted=true', () => {
    const r = filterSessions(sessions, { includeCompleted: true });
    expect(r).toHaveLength(3);
  });

  it('filters by linear id (case-insensitive)', () => {
    const r = filterSessions(sessions, { linearId: 'qua-413', includeCompleted: true });
    expect(r).toHaveLength(1);
    expect(r[0].session?.id).toBe(1);
  });

  it('filters by slot (matches either session or process slot)', () => {
    expect(filterSessions(sessions, { slot: 9, includeCompleted: true })).toHaveLength(1);
    expect(filterSessions(sessions, { slot: 11, includeCompleted: true })).toHaveLength(1); // ghost
    expect(filterSessions(sessions, { slot: 99, includeCompleted: true })).toHaveLength(0);
  });
});

describe('sortSessions — liveness bucket ordering', () => {
  it('sorts live < recent < stale < ghost < done', () => {
    const rows: MergedSession[] = [
      { session: mkSession({ id: 1 }), process: null, liveness: 'done', ageMinutes: 1 },
      { session: mkSession({ id: 2 }), process: null, liveness: 'live', ageMinutes: 1 },
      { session: mkSession({ id: 3 }), process: null, liveness: 'stale', ageMinutes: 1 },
      { session: null, process: { pid: 1, cwd: '/a1', slot: 1 }, liveness: 'ghost', ageMinutes: null },
      { session: mkSession({ id: 4 }), process: null, liveness: 'recent', ageMinutes: 1 },
    ];
    const sorted = sortSessions(rows);
    expect(sorted.map((r) => r.liveness)).toEqual(['live', 'recent', 'stale', 'ghost', 'done']);
  });

  it('sorts within a bucket by recency (newest first)', () => {
    const older = mkSession({
      id: 1,
      heartbeatAt: new Date(NOW - 5 * 60_000).toISOString(),
    });
    const newer = mkSession({
      id: 2,
      heartbeatAt: new Date(NOW - 1 * 60_000).toISOString(),
    });
    const sorted = sortSessions([
      { session: older, process: null, liveness: 'recent', ageMinutes: 5 },
      { session: newer, process: null, liveness: 'recent', ageMinutes: 1 },
    ]);
    expect(sorted.map((r) => r.session?.id)).toEqual([2, 1]);
  });
});

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

describe('formatAge', () => {
  it('returns — for null', () => {
    expect(formatAge(null)).toBe('—');
  });
  it('shows <1m for sub-minute ages', () => {
    expect(formatAge(0.5)).toBe('<1m');
  });
  it('rounds minutes under 60', () => {
    expect(formatAge(5.4)).toBe('5m');
    expect(formatAge(59)).toBe('59m');
  });
  it('promotes 59.5m to the hours bucket (no "60m" wraparound)', () => {
    // 59.5 rounds to 60, which would display as "60m" without the fix.
    // Now it correctly falls through to the hours branch.
    expect(formatAge(59.5)).toBe('1.0h');
  });
  it('uses hours between 1h and 24h', () => {
    expect(formatAge(60)).toBe('1.0h');
    expect(formatAge(120)).toBe('2.0h');
  });
  it('uses days >=24h', () => {
    expect(formatAge(60 * 24)).toBe('1.0d');
    expect(formatAge(60 * 24 * 7)).toBe('7.0d');
  });
});

describe('formatPr', () => {
  it('extracts PR number from a GitHub URL', () => {
    expect(formatPr('https://github.com/owner/repo/pull/1234')).toBe('#1234');
    expect(formatPr('https://github.com/owner/repo/pull/1234?foo=bar')).toBe('#1234');
  });
  it('handles a bare number', () => {
    expect(formatPr('4296')).toBe('#4296');
  });
  it('truncates unrecognized PR strings', () => {
    const long = 'not-a-pr-url-but-very-long-string';
    expect(formatPr(long)).toBe('not-a-pr-url-b…');
  });
  it('returns — for null/undefined', () => {
    expect(formatPr(null)).toBe('—');
    expect(formatPr(undefined)).toBe('—');
  });
});

describe('truncate', () => {
  it('does not truncate strings at or under width', () => {
    expect(truncate('hello', 5)).toBe('hello');
    expect(truncate('hi', 5)).toBe('hi');
  });
  it('adds ellipsis when over width', () => {
    expect(truncate('hello world', 8)).toBe('hello w…');
  });
  it('returns — for null/undefined', () => {
    expect(truncate(null, 5)).toBe('—');
    expect(truncate(undefined, 5)).toBe('—');
  });
  it('returns — for empty string (regression — empty string is falsy)', () => {
    expect(truncate('', 5)).toBe('—');
  });
});

describe('toDisplayRow', () => {
  it('renders a DB session into display columns', () => {
    const row = toDisplayRow({
      session: mkSession({
        id: 1,
        slotNumber: 9,
        branch: 'claude/qua-413-sessions-list',
        linearId: 'QUA-413',
        prUrl: 'https://github.com/owner/repo/pull/4296',
        task: 'Build cross-session observability',
        status: 'active',
      }),
      process: { pid: 42, cwd: '/lw/a9', slot: 9 },
      liveness: 'live',
      ageMinutes: 1,
    });
    expect(row).toMatchObject({
      slot: 'a9',
      branch: 'claude/qua-413-sessions-list',
      linear: 'QUA-413',
      pr: '#4296',
      age: '1m',
      status: 'active',
      liveness: 'live',
      pid: '42',
    });
  });

  it('renders a ghost row with — for DB-only fields', () => {
    const row = toDisplayRow({
      session: null,
      process: { pid: 7, cwd: '/lw/a11', slot: 11 },
      liveness: 'ghost',
      ageMinutes: null,
    });
    expect(row).toMatchObject({
      slot: 'a11',
      branch: '—',
      linear: '—',
      pr: '—',
      age: '—',
      status: 'ghost',
      liveness: 'ghost',
      pid: '7',
    });
    expect(row.task).toContain('ghost');
  });
});
