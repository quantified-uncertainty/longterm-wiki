/**
 * `crux sys sessions list` — fetch, correlate, and format active agent sessions.
 *
 * Data sources:
 *   - PG `agent_sessions` via wiki-server (authoritative: who registered)
 *   - Local `claude` processes via lsof (best-effort: who's actually running)
 *
 * The merge surfaces three states a coordinator cares about:
 *   - LIVE:  DB row with fresh heartbeat AND matching ps process in slot cwd
 *   - STALE: DB row with old heartbeat (>fresh window), still status='active'
 *            — session probably crashed without calling /agent-end or sweep
 *   - GHOST: live claude process whose cwd's slot has no active DB row
 *            — session started work without `agent-checklist init`
 *
 * This file is pure data-shaping so the command handler stays thin and the
 * merge/format logic is unit-testable without a running wiki-server.
 */

import type { AgentSessionListResponse } from '../wiki-server/agent-sessions.ts';
import type { ClaudeProcess } from './claude-processes.ts';
import { truncate as truncateText } from '../text-utils.ts';

type DbSession = AgentSessionListResponse['sessions'][number];

export type Liveness = 'live' | 'recent' | 'stale' | 'done' | 'ghost';

export interface MergedSession {
  /** DB row. null for GHOST rows where only a live process exists. */
  session: DbSession | null;
  /** Matching live claude process (by slot). null if none found. */
  process: ClaudeProcess | null;
  liveness: Liveness;
  ageMinutes: number | null;
}

export interface MergeOptions {
  /** Now, for deterministic tests. Defaults to Date.now(). */
  now?: number;
  /** Heartbeat freshness for "live" bucket. Default 2 min. */
  liveMinutes?: number;
  /** Staleness cutoff: active rows older than this are STALE. Default 30 min. */
  staleMinutes?: number;
}

/** Parse an ISO timestamp into epoch ms. Returns null for null/invalid input. */
function parseTs(ts: string | Date | null | undefined): number | null {
  if (!ts) return null;
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  const n = d.getTime();
  return Number.isFinite(n) ? n : null;
}

/**
 * Pick the best liveness signal: prefer dedicated heartbeatAt, fall back to
 * updatedAt. Older sessions predate heartbeatAt and rely on updatedAt alone.
 */
function lastSignal(s: DbSession): number | null {
  return parseTs(s.heartbeatAt) ?? parseTs(s.updatedAt);
}

/**
 * Coerce a user-provided option to a positive number, falling back to
 * `fallback` for NaN, negatives, and zero. Defended inside `mergeSessions`
 * so non-CLI callers (dashboards, scripts) can't accidentally classify
 * every row as stale by passing in a bad value.
 */
function positiveOr(n: number | undefined, fallback: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/**
 * Merge DB session rows with live claude processes.
 *
 * A row is matched to a process by slot number (both must be non-null and
 * equal). Extra processes in the same slot (rare — a stuck subagent or
 * crashed-parent scenario) are emitted as separate ghost rows so the
 * "is anyone else using this slot?" signal isn't silently lost.
 */
export function mergeSessions(
  sessions: DbSession[],
  processes: ClaudeProcess[],
  opts: MergeOptions = {},
): MergedSession[] {
  const now = opts.now ?? Date.now();
  const liveMs = positiveOr(opts.liveMinutes, 2) * 60_000;
  const staleMs = positiveOr(opts.staleMinutes, 30) * 60_000;

  // Track which (slot, pid) pairs get bound to a DB session. Anything left
  // over becomes a ghost row.
  const bound = new Set<number>(); // pids bound to a DB session
  const processBySlot = new Map<number, ClaudeProcess[]>();
  for (const p of processes) {
    if (p.slot === null) continue;
    const list = processBySlot.get(p.slot) ?? [];
    list.push(p);
    processBySlot.set(p.slot, list);
  }

  const rows: MergedSession[] = [];

  for (const s of sessions) {
    const sig = lastSignal(s);
    const age = sig === null ? null : now - sig;
    const ageMin = age === null ? null : age / 60_000;

    let proc: ClaudeProcess | null = null;
    if (s.slotNumber !== null) {
      const candidates = processBySlot.get(s.slotNumber) ?? [];
      // Bind the first unbound process in this slot to the session.
      const picked = candidates.find((p) => !bound.has(p.pid));
      if (picked) {
        proc = picked;
        bound.add(picked.pid);
      }
    }

    let liveness: Liveness;
    if (s.status === 'completed') {
      liveness = 'done';
    } else if (age !== null && age < liveMs) {
      liveness = 'live';
    } else if (age !== null && age < staleMs) {
      liveness = 'recent';
    } else {
      liveness = 'stale';
    }

    rows.push({ session: s, process: proc, liveness, ageMinutes: ageMin });
  }

  // GHOSTs: every process not bound to a DB session. This includes both
  // slots that have no DB row at all AND slots with extra processes beyond
  // the first (e.g. a stuck subagent).
  for (const p of processes) {
    if (p.slot === null || bound.has(p.pid)) continue;
    rows.push({ session: null, process: p, liveness: 'ghost', ageMinutes: null });
  }

  return rows;
}

export interface FilterOptions {
  /** If false (default), drop 'done' rows. */
  includeCompleted?: boolean;
  /** Only show rows for this linear ID (e.g. "QUA-413"). */
  linearId?: string;
  /** Only show rows for this slot number. */
  slot?: number;
}

export function filterSessions(rows: MergedSession[], opts: FilterOptions): MergedSession[] {
  const linearId = opts.linearId?.toUpperCase();
  return rows.filter((r) => {
    if (!opts.includeCompleted && r.liveness === 'done') return false;
    if (linearId) {
      const rowLinear = r.session?.linearId?.toUpperCase() ?? null;
      if (rowLinear !== linearId) return false;
    }
    if (opts.slot !== undefined) {
      const rowSlot = r.session?.slotNumber ?? r.process?.slot ?? null;
      if (rowSlot !== opts.slot) return false;
    }
    return true;
  });
}

/**
 * Sort for display: LIVE first, then RECENT, STALE, GHOST, DONE. Within a
 * bucket, newer sessions first.
 */
const LIVENESS_ORDER: Record<Liveness, number> = {
  live: 0,
  recent: 1,
  stale: 2,
  ghost: 3,
  done: 4,
};

export function sortSessions(rows: MergedSession[]): MergedSession[] {
  return [...rows].sort((a, b) => {
    const o = LIVENESS_ORDER[a.liveness] - LIVENESS_ORDER[b.liveness];
    if (o !== 0) return o;
    // Newer first. Missing signal sorts last within the bucket.
    const aSig = a.session ? lastSignal(a.session) : null;
    const bSig = b.session ? lastSignal(b.session) : null;
    if (aSig === null && bSig === null) return 0;
    if (aSig === null) return 1;
    if (bSig === null) return -1;
    return bSig - aSig;
  });
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function truncate(s: string | null | undefined, width: number): string {
  if (!s) return '—';
  return truncateText(s, width);
}

export function formatAge(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 1) return '<1m';
  // Round before checking the boundary so 59.5m renders as 1.0h, not 60m.
  const m = Math.round(minutes);
  if (m < 60) return `${m}m`;
  const h = minutes / 60;
  if (h < 24) return `${h.toFixed(1)}h`;
  const d = h / 24;
  return `${d.toFixed(1)}d`;
}

export function formatPr(prUrl: string | null | undefined): string {
  if (!prUrl) return '—';
  // Match /pull/N at the end of a GitHub URL
  const m = prUrl.match(/\/pull\/(\d+)(?:$|\?|#|\/)/);
  if (m) return `#${m[1]}`;
  // Bare number
  if (/^\d+$/.test(prUrl)) return `#${prUrl}`;
  // Give up and truncate
  return truncate(prUrl, 15);
}

export interface DisplayRow {
  slot: string;
  branch: string;
  linear: string;
  pr: string;
  task: string;
  age: string;
  status: string;
  liveness: Liveness;
  pid: string;
}

export function toDisplayRow(r: MergedSession): DisplayRow {
  const s = r.session;
  const slotNum = s?.slotNumber ?? r.process?.slot ?? null;
  const slot = slotNum === null ? '—' : `a${slotNum}`;
  const branch = truncate(s?.branch ?? '—', 40);
  const linear = s?.linearId ?? '—';
  const pr = formatPr(s?.prUrl);
  const task = truncate(s?.task ?? '(ghost claude process — not registered)', 40);
  const age = formatAge(r.ageMinutes);
  const status = s?.status ?? 'ghost';
  const pid = r.process ? String(r.process.pid) : '—';
  return { slot, branch, linear, pr, task, age, status, liveness: r.liveness, pid };
}
