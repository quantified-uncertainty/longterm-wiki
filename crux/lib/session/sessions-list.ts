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
 * Merge DB session rows with live claude processes.
 *
 * A row is matched to a process by slot number (both must be non-null and
 * equal). This correctly handles the common case of one session per slot.
 * Multiple processes in the same slot are unusual but not impossible (stuck
 * subagent, crashed parent); we take the first match and surface the rest
 * as implicit GHOSTs? — no, simpler: we emit one row per DB session plus
 * one GHOST row per live process with no matching DB session.
 */
export function mergeSessions(
  sessions: DbSession[],
  processes: ClaudeProcess[],
  opts: MergeOptions = {},
): MergedSession[] {
  const now = opts.now ?? Date.now();
  const liveMs = (opts.liveMinutes ?? 2) * 60_000;
  const staleMs = (opts.staleMinutes ?? 30) * 60_000;

  // Build slot → process lookup. If multiple processes share a slot, keep
  // the first; extras become GHOSTs below.
  const processBySlot = new Map<number, ClaudeProcess>();
  const consumed = new Set<number>();
  for (const p of processes) {
    if (p.slot !== null && !processBySlot.has(p.slot)) {
      processBySlot.set(p.slot, p);
    }
  }

  const rows: MergedSession[] = [];

  for (const s of sessions) {
    const sig = lastSignal(s);
    const age = sig === null ? null : now - sig;
    const ageMin = age === null ? null : age / 60_000;

    let proc: ClaudeProcess | null = null;
    if (s.slotNumber !== null && processBySlot.has(s.slotNumber)) {
      proc = processBySlot.get(s.slotNumber) ?? null;
      consumed.add(s.slotNumber);
    }

    let liveness: Liveness;
    if (s.status === 'completed') {
      liveness = 'done';
    } else if (age !== null && age <= liveMs) {
      liveness = 'live';
    } else if (age !== null && age <= staleMs) {
      liveness = 'recent';
    } else {
      liveness = 'stale';
    }

    rows.push({ session: s, process: proc, liveness, ageMinutes: ageMin });
  }

  // GHOSTs: live processes whose slot has no matching active DB row. These
  // are the most alarming category — a session is running without having
  // registered via agent-checklist init.
  for (const p of processes) {
    if (p.slot === null || consumed.has(p.slot)) continue;
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
  if (s.length <= width) return s;
  return s.slice(0, width - 1) + '…';
}

export function formatAge(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${Math.round(minutes)}m`;
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
