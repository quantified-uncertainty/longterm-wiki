/**
 * Coordinator session sentinel — role-conflation guard.
 *
 * Two coordinator roles ("slots" and "releases") MUST live in separate
 * Claude Code sessions. The sentinel is a /tmp file each startup skill
 * writes; the other role's startup checks for a live sentinel from the
 * SAME tmux pane / process to detect role conflation in one session.
 *
 * This module is pure: all environment access (fs, env, time, tmux) is
 * injected via a SentinelEnv. Tests provide an in-memory env.
 */

export type Role = 'slots' | 'releases';

export const SENTINEL_DIR = '/tmp';
export const SENTINEL_PREFIX = 'lw-coord-sentinel';
export const TTL_SECONDS = 86_400; // 24h — matches QUA-326 decision

/** Parsed sentinel file contents (single key=value line). */
export interface Sentinel {
  role: Role;
  /** tmux pane id with leading `%` (e.g. `%69`); empty string if non-tmux startup */
  tmuxPane: string;
  /** parent pid — used as fallback liveness signal when no tmux pane */
  ppid: number;
  /** unix epoch seconds */
  created: number;
  host: string;
  /** numeric uid */
  user: number;
}

export type ConflictKind = 'same-session' | 'other-session';

export interface Conflict {
  kind: ConflictKind;
  path: string;
  sentinel: Sentinel;
  ageSeconds: number;
}

export interface SentinelCheckResult {
  /** Path of OUR sentinel for this role (whether or not it exists). */
  ourPath: string;
  /** First conflict found, if any. */
  conflict: Conflict | null;
  /** Number of stale sentinels removed during this scan. */
  cleaned: number;
}

export interface SentinelEnv {
  now(): Date;
  /** Return file contents or null if absent. */
  readFile(path: string): string | null;
  writeFile(path: string, content: string): void;
  /** Touch (update mtime). Throws if file does not exist. */
  touch(path: string): void;
  /** Return mtime in unix-epoch-seconds, or null if file missing/unreadable. */
  statMtime(path: string): number | null;
  /** Delete a file. No-op if it does not exist. */
  unlink(path: string): void;
  /** List filenames in dir matching prefix (returns full paths). */
  listMatching(dir: string, prefix: string): string[];
  /**
   * Return all live tmux pane ids (e.g. `["%1","%2","%69"]`).
   * Returns `null` when not in tmux or tmux not available.
   */
  listTmuxPanes(): string[] | null;
  /** Return true if process with this pid exists (kill -0). */
  pidAlive(pid: number): boolean;
  /** Process env — for $TMUX_PANE / $PPID / $TMUX detection at write time. */
  env: NodeJS.ProcessEnv;
  hostname(): string;
  uid(): number;
  /** Process pid (for fallback PPID when env.PPID missing). */
  ppid(): number;
}

// ---------------------------------------------------------------------------
// Path + key derivation
// ---------------------------------------------------------------------------

/**
 * Derive the per-session key used in the sentinel filename.
 *
 * Preference: `TMUX_PANE` minus its leading `%`. Falls back to `pid-<PPID>`
 * for non-tmux startups. Stable across Bash subprocesses within one Claude
 * session because Claude Code exports `TMUX_PANE` to all tools.
 */
export function deriveSessionKey(env: NodeJS.ProcessEnv, ppid: number): string {
  const pane = env.TMUX_PANE;
  if (pane && pane.length > 0) {
    const raw = pane.startsWith('%') ? pane.slice(1) : pane;
    return sanitizeSessionKey(raw) || `pid-${ppid}`;
  }
  return `pid-${ppid}`;
}

/**
 * Strip any character that could make the session key escape `/tmp/`. The
 * legitimate inputs are tmux pane ids (`\d+`) and our own `pid-<n>`
 * fallback; anything else is rejected to prevent a hostile TMUX_PANE from
 * steering writes into unrelated paths.
 */
function sanitizeSessionKey(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '');
}

export function sentinelPath(role: Role, sessionKey: string): string {
  return `${SENTINEL_DIR}/${SENTINEL_PREFIX}-${role}-${sessionKey}`;
}

export function otherRole(role: Role): Role {
  return role === 'slots' ? 'releases' : 'slots';
}

// ---------------------------------------------------------------------------
// Serialize / parse
// ---------------------------------------------------------------------------

/**
 * Serialize a sentinel to its single-line key=value form.
 *
 * Format chosen to be human-readable in `cat`, parseable in bash, and
 * resistant to corruption by intermediate `sed`/`grep` pipes.
 *
 * We sanitize `host` to drop whitespace because macOS computer names can
 * contain spaces (e.g. "Ozzie's MacBook"), and whitespace in a value would
 * split the key=value pairs at parse time — making our own sentinel
 * unparseable and silently defeating the role-conflation guard.
 */
export function serializeSentinel(s: Sentinel): string {
  const pane = s.tmuxPane.startsWith('%') || s.tmuxPane === '' ? s.tmuxPane : `%${s.tmuxPane}`;
  const host = sanitizeFieldValue(s.host);
  return `role=${s.role} tmux_pane=${pane} ppid=${s.ppid} created=${s.created} host=${host} user=${s.user}\n`;
}

/** Replace whitespace and `=` with `_` so a value never splits the field list. */
function sanitizeFieldValue(v: string): string {
  return v.replace(/[\s=]+/g, '_');
}

/**
 * Parse a sentinel file. Returns null on any malformed input — we never
 * fail-open on garbage; callers should treat unparseable as absent.
 */
export function parseSentinel(content: string): Sentinel | null {
  const line = content.split('\n').find((l) => l.trim().length > 0);
  if (!line) return null;
  const fields: Record<string, string> = {};
  for (const tok of line.trim().split(/\s+/)) {
    const eq = tok.indexOf('=');
    if (eq <= 0) return null;
    fields[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  const role = fields.role;
  if (role !== 'slots' && role !== 'releases') return null;
  const ppid = Number(fields.ppid);
  const created = Number(fields.created);
  const user = Number(fields.user);
  if (!Number.isFinite(ppid) || !Number.isFinite(created) || !Number.isFinite(user)) return null;
  return {
    role,
    tmuxPane: fields.tmux_pane ?? '',
    ppid,
    created,
    host: fields.host ?? '',
    user,
  };
}

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

export interface LivenessResult {
  live: boolean;
  reason: 'fresh' | 'expired' | 'pane-gone' | 'pid-gone' | 'unparseable';
  ageSeconds: number;
}

/**
 * Decide whether a sentinel file represents a live coordinator session.
 *
 * Strategy:
 * 1. Mtime > TTL → expired (laptop sleep tolerance: 24h, not 12h)
 * 2. If `tmux_pane` set AND we have a live tmux pane list → pane must still exist
 * 3. Else if `ppid` set → `kill -0 ppid` must succeed
 * 4. Otherwise treat as live (fail-closed: when in doubt, do not delete)
 *
 * Unparseable sentinels are treated as live to avoid clobbering
 * sentinels written by a future format we don't understand yet.
 */
export function isLive(
  path: string,
  parsed: Sentinel | null,
  env: SentinelEnv,
): LivenessResult {
  const mtime = env.statMtime(path);
  if (mtime == null) return { live: false, reason: 'expired', ageSeconds: Infinity };
  const nowSec = Math.floor(env.now().getTime() / 1000);
  const age = nowSec - mtime;
  if (age > TTL_SECONDS) return { live: false, reason: 'expired', ageSeconds: age };
  if (!parsed) return { live: true, reason: 'unparseable', ageSeconds: age };

  if (parsed.tmuxPane) {
    const panes = env.listTmuxPanes();
    if (panes != null) {
      if (!panes.includes(parsed.tmuxPane)) {
        return { live: false, reason: 'pane-gone', ageSeconds: age };
      }
    }
    // panes == null: tmux unavailable, can't disprove → fall through to live
  } else if (parsed.ppid > 0) {
    if (!env.pidAlive(parsed.ppid)) {
      return { live: false, reason: 'pid-gone', ageSeconds: age };
    }
  }
  return { live: true, reason: 'fresh', ageSeconds: age };
}

// ---------------------------------------------------------------------------
// Top-level operations: write, check, touch
// ---------------------------------------------------------------------------

export function buildOurSentinel(role: Role, env: SentinelEnv): { path: string; sentinel: Sentinel } {
  const ppid = Number(env.env.PPID ?? env.ppid());
  const sessionKey = deriveSessionKey(env.env, ppid);
  const pane = env.env.TMUX_PANE ?? '';
  const sentinel: Sentinel = {
    role,
    tmuxPane: pane,
    ppid: Number.isFinite(ppid) ? ppid : 0,
    created: Math.floor(env.now().getTime() / 1000),
    host: env.hostname(),
    user: env.uid(),
  };
  return { path: sentinelPath(role, sessionKey), sentinel };
}

export function writeSentinel(role: Role, env: SentinelEnv): { path: string; sentinel: Sentinel } {
  const { path, sentinel } = buildOurSentinel(role, env);
  env.writeFile(path, serializeSentinel(sentinel));
  return { path, sentinel };
}

export function touchSentinel(role: Role, env: SentinelEnv): { path: string; touched: boolean } {
  const ppid = Number(env.env.PPID ?? env.ppid());
  const sessionKey = deriveSessionKey(env.env, ppid);
  const path = sentinelPath(role, sessionKey);
  if (env.statMtime(path) == null) return { path, touched: false };
  env.touch(path);
  return { path, touched: true };
}

/**
 * Scan for conflicting sentinels from the OTHER role.
 *
 * Returns the first live conflict found, classified by whether it shares
 * our session key (same-session = role conflation, the blocker) or comes
 * from a different session (cross-session = expected, informational).
 *
 * Stale sentinels of the other role are removed opportunistically.
 */
export function checkConflict(role: Role, env: SentinelEnv): SentinelCheckResult {
  const ppid = Number(env.env.PPID ?? env.ppid());
  const ourKey = deriveSessionKey(env.env, ppid);
  const ourPath = sentinelPath(role, ourKey);
  const other = otherRole(role);
  const otherPrefix = `${SENTINEL_PREFIX}-${other}-`;
  const candidates = env.listMatching(SENTINEL_DIR, otherPrefix);

  let conflict: Conflict | null = null;
  let cleaned = 0;

  for (const path of candidates) {
    const content = env.readFile(path);
    const parsed = content == null ? null : parseSentinel(content);
    const liveness = isLive(path, parsed, env);
    if (!liveness.live) {
      env.unlink(path);
      cleaned += 1;
      continue;
    }
    if (conflict != null || parsed == null) continue;
    // Determine session match: prefer pane id, fall back to ppid match
    const sentinelKey =
      parsed.tmuxPane && parsed.tmuxPane.startsWith('%')
        ? parsed.tmuxPane.slice(1)
        : parsed.tmuxPane || `pid-${parsed.ppid}`;
    const kind: ConflictKind = sentinelKey === ourKey ? 'same-session' : 'other-session';
    conflict = { kind, path, sentinel: parsed, ageSeconds: liveness.ageSeconds };
  }

  return { ourPath, conflict, cleaned };
}
