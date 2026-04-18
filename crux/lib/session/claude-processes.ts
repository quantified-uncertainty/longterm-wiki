/**
 * Claude Code process scanner — live cross-reference for `crux sys sessions list`.
 *
 * The PG `agent_sessions` table is the authoritative source of truth for who's
 * working on what, but it trusts sessions to register themselves via
 * `agent-checklist init`. A crashed or never-init'd Claude Code process leaves
 * no DB trace. This module scans the local `ps` table for Claude Code
 * processes and resolves their CWD via `lsof` so `sessions list` can flag:
 *
 *   - DB rows without a matching live process  (stale/dead)
 *   - Live processes without a DB row           (untracked — init was skipped)
 *
 * Two-step scan because `lsof -c claude` does not match Claude Code on macOS:
 * the installer delivers a versioned native binary at
 * `~/.local/share/claude/versions/<version>` and the process's command name
 * is the version string ("2.1.112"), not "claude". We identify Claude Code
 * processes by their args containing `/share/claude/versions/` (installed
 * binary path) OR by a bare `claude` args line (the wrapper script).
 *
 * Darwin and Linux are supported. Fails open (returns []) on any error — the
 * command must still be useful without live data.
 */

import { execSync } from 'child_process';
import { findSlotFromAncestors } from './session-context.ts';

export interface ClaudeProcess {
  pid: number;
  cwd: string;
  /** Slot number (a<N>) derived from the cwd ancestor walk, or null. */
  slot: number | null;
}

export interface ProcessScanDeps {
  execCmd?: (cmd: string) => string;
}

/**
 * Pattern for a Claude Code process in `ps` args output. Matches either:
 *   - the installed binary path (`.../share/claude/versions/<version>`)
 *   - a bare `claude` wrapper invocation (the CLI symlink)
 *
 * Deliberately strict: `grep claude`, `tsc claude.ts`, and other tools
 * mentioning the word in arguments must not match. `\bclaude\b` inside a
 * longer grep arg line is caught by the `/share/claude/versions/` clause
 * only when the binary path is literally present.
 */
const CLAUDE_PROCESS_RE =
  /(?:\/share\/claude\/versions\/|(?:^|\s)claude(?:\s|$))/;

/** Extract PIDs from `ps -eo pid=,args=` output that look like Claude Code. */
export function findClaudePids(psOutput: string): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number.parseInt(m[1], 10);
    const args = m[2];
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    // Self-exclusion: don't match `ps` or its pipeline itself.
    if (/^(ps|grep|lsof)\b/.test(args)) continue;
    if (CLAUDE_PROCESS_RE.test(args)) pids.push(pid);
  }
  return pids;
}

/** Parse `lsof -a -p <pids> -d cwd -Fpn` output into {pid, cwd} pairs. */
export function parseLsofFpn(raw: string): Array<{ pid: number; cwd: string }> {
  const out: Array<{ pid: number; cwd: string }> = [];
  let pid: number | null = null;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const rest = line.slice(1);
    if (tag === 'p') {
      const n = Number.parseInt(rest, 10);
      pid = Number.isSafeInteger(n) && n > 0 ? n : null;
    } else if (tag === 'n' && pid !== null) {
      out.push({ pid, cwd: rest });
      pid = null;
    }
  }
  return out;
}

export interface ProcessScanResult {
  processes: ClaudeProcess[];
  /**
   * Null when the scan ran successfully (with 0+ processes found). Non-null
   * when the scan could not complete (ps/lsof missing, timeout, permission
   * denied). Callers must distinguish this from "no processes found" — a
   * silent scan failure would give a coordinator a false "no ghosts" signal,
   * exactly the QUA-413 failure mode this command is meant to prevent.
   */
  scanError: string | null;
}

/**
 * List all running Claude Code processes and their working directories.
 * On failure returns `{ processes: [], scanError: '<reason>' }`. On success
 * with nothing found, returns `{ processes: [], scanError: null }`.
 */
export function findClaudeProcesses(deps: ProcessScanDeps = {}): ProcessScanResult {
  const exec =
    deps.execCmd ??
    ((cmd: string) =>
      execSync(cmd, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }));

  // Step 1: ps to find candidate PIDs.
  let psOut = '';
  try {
    psOut = exec('ps -eo pid=,args=');
  } catch (e) {
    return { processes: [], scanError: `ps failed: ${errMsg(e)}` };
  }
  const pids = findClaudePids(psOut);
  if (pids.length === 0) {
    return { processes: [], scanError: null };
  }

  // Step 2: lsof for CWD. Must use `-a` to AND the `-p` and `-d` filters on
  // macOS — without it, lsof ORs the filters and returns every process.
  // Comma-separated PID list is supported on both Darwin and Linux.
  let lsofOut = '';
  try {
    lsofOut = exec(`lsof -a -p ${pids.join(',')} -d cwd -Fpn`);
  } catch (e) {
    return { processes: [], scanError: `lsof failed: ${errMsg(e)}` };
  }
  const pairs = parseLsofFpn(lsofOut);
  return {
    processes: pairs.map(({ pid, cwd }) => ({ pid, cwd, slot: findSlotFromAncestors(cwd) })),
    scanError: null,
  };
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message.slice(0, 200);
  return String(e).slice(0, 200);
}
