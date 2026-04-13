/**
 * Tmux helpers for the coordinator role lifecycle.
 *
 * - Version probe (some features need tmux ≥ 3.0)
 * - Window claim: rename to role name + set @lw-coord-role marker so the
 *   periodic rename loop knows not to clobber it
 * - Marker query: bulk-read @lw-coord-role across all windows in one call
 *
 * Pure: all shell access goes through an injected `TmuxExec` so tests
 * never have to fork a real tmux.
 */

export type Role = 'slots' | 'releases';

export const ROLE_MARKER = '@lw-coord-role';

export interface TmuxExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface TmuxExec {
  /** Returns the value of TMUX env var, or null if not in a tmux session. */
  inTmux(): string | null;
  /**
   * Run `tmux <args>`. Implementations should NOT throw on non-zero exit;
   * return the result with code/stderr so callers can branch.
   */
  run(args: string[]): TmuxExecResult;
}

// ---------------------------------------------------------------------------
// Version probe
// ---------------------------------------------------------------------------

export interface TmuxVersion {
  raw: string;
  major: number;
  minor: number;
  /** True when version ≥ 3.0 (required for `#{@user-option}` format strings). */
  supportsUserOptionFormat: boolean;
}

/**
 * Parse `tmux -V` output. Handles common forms:
 *   "tmux 3.3a"
 *   "tmux 3.4"
 *   "tmux 2.9a"
 *   "tmux next-3.5"
 *   "tmux master"  (returns 0.0)
 */
export function parseTmuxVersion(raw: string): TmuxVersion {
  const trimmed = raw.trim();
  const m = trimmed.match(/(\d+)\.(\d+)/);
  if (!m) {
    return { raw: trimmed, major: 0, minor: 0, supportsUserOptionFormat: false };
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return {
    raw: trimmed,
    major,
    minor,
    supportsUserOptionFormat: major > 3 || (major === 3 && minor >= 0),
  };
}

export function probeTmuxVersion(exec: TmuxExec): TmuxVersion | null {
  if (exec.inTmux() == null) return null;
  const r = exec.run(['-V']);
  if (r.code !== 0) return null;
  return parseTmuxVersion(r.stdout);
}

// ---------------------------------------------------------------------------
// Window listing + marker query
// ---------------------------------------------------------------------------

export interface TmuxWindowMarker {
  windowId: string; // e.g. "@7"
  index: string;    // e.g. "3"
  name: string;
  role: Role | null; // null if unmarked
}

/**
 * Bulk-query all windows across all sessions, returning each window's
 * id/index/name and `@lw-coord-role` marker (or null).
 *
 * Requires tmux ≥ 3.0 for `#{@user-option}` substitution. On older tmux
 * (or when version probe fails) returns marker=null for every window —
 * caller should treat that as "no markers", which means the rename loop
 * will fall back to its current behavior (rename everything).
 */
export function listWindowsWithMarkers(
  exec: TmuxExec,
  version: TmuxVersion | null,
): TmuxWindowMarker[] {
  const useMarker = version?.supportsUserOptionFormat ?? false;
  const fmt = useMarker
    ? `#{window_id}\t#{window_index}\t#{window_name}\t#{${ROLE_MARKER}}`
    : `#{window_id}\t#{window_index}\t#{window_name}`;
  const r = exec.run(['list-windows', '-a', '-F', fmt]);
  if (r.code !== 0) return [];
  const out: TmuxWindowMarker[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const role = useMarker ? normalizeRole(parts[3] ?? '') : null;
    out.push({
      windowId: parts[0],
      index: parts[1],
      name: parts[2],
      role,
    });
  }
  return out;
}

function normalizeRole(s: string): Role | null {
  const v = s.trim();
  if (v === 'slots' || v === 'releases') return v;
  return null;
}

// ---------------------------------------------------------------------------
// Window claim
// ---------------------------------------------------------------------------

export interface ClaimResult {
  status: 'claimed' | 'skipped-no-tmux' | 'skipped-no-current' | 'error';
  finalName?: string;
  marker?: Role;
  detail?: string;
  /** If the version probe says markers are unsupported, this is set. */
  markerUnsupported?: boolean;
}

/**
 * Claim the current tmux window for `role`.
 *
 * Steps (order matters for race-safety):
 *   1. Probe tmux version.
 *   2. List existing window names; pick `<role>` or `<role>-N` to avoid collision.
 *   3. SET the marker FIRST so the rename loop (which reads the marker
 *      before deciding whether to rename) never sees the window without it.
 *   4. Rename the window.
 *
 * Idempotent: re-running with the same role on a marked window finds the
 * existing name in step 2 and may pick a different suffix; callers should
 * tolerate this (it's still our window, just renumbered).
 */
export function claimWindow(role: Role, exec: TmuxExec): ClaimResult {
  if (exec.inTmux() == null) {
    return { status: 'skipped-no-tmux', detail: 'TMUX env var not set' };
  }
  const version = probeTmuxVersion(exec);
  const markerUnsupported = version != null && !version.supportsUserOptionFormat;

  // Find current window id (so we know which one to operate on)
  const cur = exec.run(['display-message', '-p', '#{window_id}']);
  if (cur.code !== 0 || !cur.stdout.trim()) {
    return { status: 'skipped-no-current', detail: 'tmux display-message failed' };
  }
  const currentId = cur.stdout.trim();

  // Existing windows (current session only — names are session-scoped for select-window)
  const list = exec.run(['list-windows', '-F', '#{window_name}']);
  const existing = new Set(
    list.code === 0
      ? list.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
      : [],
  );

  let finalName = role as string;
  if (existing.has(finalName)) {
    let n = 2;
    while (existing.has(`${role}-${n}`)) n += 1;
    finalName = `${role}-${n}`;
  }

  // 1. Set marker BEFORE rename (race fix from QUA-326 red team)
  if (!markerUnsupported) {
    const set = exec.run(['set-option', '-w', '-t', currentId, ROLE_MARKER, role]);
    if (set.code !== 0) {
      return {
        status: 'error',
        detail: `set-option ${ROLE_MARKER} failed: ${set.stderr}`,
        markerUnsupported,
      };
    }
  }

  // 2. Rename
  const ren = exec.run(['rename-window', '-t', currentId, finalName]);
  if (ren.code !== 0) {
    return { status: 'error', detail: `rename-window failed: ${ren.stderr}`, markerUnsupported };
  }

  return {
    status: 'claimed',
    finalName,
    marker: markerUnsupported ? undefined : role,
    markerUnsupported,
  };
}
