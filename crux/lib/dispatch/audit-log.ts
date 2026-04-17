/**
 * Dispatch audit log — QUA-437
 *
 * Appends one JSONL line per `crux sys dispatch` invocation to
 * `~/.cache/crux-dispatch/log.jsonl`, so cross-session "who dispatched
 * what, when, and under what circumstances" is queryable without
 * spelunking through Linear comments or tmux history.
 *
 * Fields intentionally sparse — enough to reconstruct a timeline and
 * identify forced claims, without duplicating content already in Linear
 * or the PR body. The `force` + `forceReason` fields are the primary
 * reason this log exists: `--force` claims must be traceable even when
 * the Linear comment is deleted or the ticket is closed.
 *
 * Never crashes the dispatch on write failure — best-effort, like
 * `pr-patrol/state.ts::appendJsonl`.
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

export const DISPATCH_LOG_DIR = join(homedir(), '.cache', 'crux-dispatch');
export const DISPATCH_LOG_FILE = join(DISPATCH_LOG_DIR, 'log.jsonl');

export type DispatchOutcome = 'dispatched' | 'refused' | 'forced' | 'dry-run';

export interface DispatchLogEntry {
  /** Linear issue identifier, e.g. "QUA-437". */
  linearId: string;
  /** Target slot number (the slot we opened, not the dispatcher's slot). */
  slot: number;
  /**
   * What happened. `refused` = pre-flight blocked and no `--force`.
   * `forced` = pre-flight blocked but operator overrode. `dry-run` =
   * pre-flight passed (or was forced past) but `--dry-run` skipped the
   * actual `./ws open`. `dispatched` = slot was opened.
   */
  outcome: DispatchOutcome;
  /** True iff `--force` was passed. Redundant with `outcome` for `refused`, but useful for filtering. */
  force: boolean;
  /** Reason string passed with `--force`. Required by the CLI when `--force` is set. */
  forceReason: string | null;
  /** Dispatcher's session context — `slot` field can be null when running outside a slot dir. */
  dispatcherSlot: number | null;
  dispatcherBranch: string;
  /** Process pid, for cross-referencing with tmux scrollback. */
  pid: number;
  /** Sorted list of pre-flight blocker tags (empty when pre-flight passed). */
  blockers: string[];
  /** Optional path to the dispatch brief if `--brief=<path>` was passed. */
  briefPath: string | null;
}

/**
 * Append an entry to the audit log. Silently swallows filesystem errors
 * — the dispatch command's job is to open a slot, not to guarantee
 * logging. A missing log line is recoverable; a failed dispatch because
 * `~/.cache` was read-only is not.
 */
export function appendDispatchLog(
  entry: DispatchLogEntry,
  opts: { file?: string; now?: () => string } = {},
): void {
  const file = opts.file ?? DISPATCH_LOG_FILE;
  const timestamp = (opts.now ?? (() => new Date().toISOString()))();

  try {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ timestamp, ...entry }) + '\n';
    appendFileSync(file, line);
  } catch {
    // Best-effort; dispatch should not fail because the log is unwritable.
  }
}
