/**
 * Linear-side dedup for wellness-check auto-filing (QUA-577).
 *
 * The GitHub-side dedup in `wellness-report.ts` already prevents stacking
 * open GitHub issues by label. Linear's GitHub integration, however, creates
 * a brand-new Linear ticket every time a new GitHub issue is filed — even
 * when a previous Linear ticket is still open or was closed only hours ago.
 * Result: 8+ near-identical Linear tickets accumulate per week.
 *
 * This module checks Linear *before* the GitHub issue is created:
 *   - If an open Linear ticket matches, comment on it and skip GitHub creation.
 *   - If the most recent match was closed inside `REOPEN_WINDOW_MS`,
 *     reopen it to Backlog and comment.
 *   - Otherwise, fall through to the normal GitHub create path.
 *
 * All lookups are fail-open: Linear outages/timeouts never block the
 * wellness pipeline. A brief warning is logged and the caller proceeds
 * with the normal GitHub path.
 */

import {
  searchIssues,
  commentOnIssue,
  updateIssueState,
  type SearchedIssue,
} from '../lib/linear/issues.ts';

/**
 * Window for treating a closed Linear wellness ticket as "still recent
 * enough to reopen instead of filing a new one." Tuned to comfortably
 * cover the ~12h gap between consecutive wellness failures — anything
 * shorter lets the duplicate-cascade pattern back in; anything longer
 * reopens tickets that have genuinely been triaged away.
 */
export const REOPEN_WINDOW_MS = 48 * 60 * 60 * 1000;

export type LinearWellnessAction =
  | { kind: 'commented'; identifier: string; url: string }
  | { kind: 'reopened'; identifier: string; url: string }
  | { kind: 'skipped'; reason: 'no-match' | 'lookup-failed' };

export interface LinearDedupDeps {
  search: typeof searchIssues;
  comment: typeof commentOnIssue;
  reopen: typeof updateIssueState;
  now: () => number;
}

const DEFAULT_DEPS: LinearDedupDeps = {
  search: searchIssues,
  comment: commentOnIssue,
  reopen: updateIssueState,
  now: Date.now,
};

function parseQuaNumber(identifier: string): number {
  const m = identifier.match(/^QUA-(\d+)$/);
  return m ? Number(m[1]) : 0;
}

function isOpen(issue: SearchedIssue): boolean {
  return issue.state.type !== 'completed' && issue.state.type !== 'canceled';
}

/**
 * Look for existing Linear wellness tickets and take the appropriate
 * deduplication action. Returns what was done; the caller decides whether
 * to proceed with its own filing path.
 *
 * @param title        The exact Linear issue title to match.
 * @param commentBody  The message to post on a match (recurrence timestamp + run link).
 * @param deps         Optional dependency overrides for tests.
 */
export async function dedupLinearWellnessIssue(
  title: string,
  commentBody: string,
  deps: Partial<LinearDedupDeps> = {},
): Promise<LinearWellnessAction> {
  const { search, comment, reopen, now } = { ...DEFAULT_DEPS, ...deps };

  let candidates: SearchedIssue[];
  try {
    // Linear's search is token-based; filter to exact title matches after.
    const results = await search(title, 20);
    candidates = results.filter((r) => r.title === title);
  } catch (err) {
    console.warn(
      `Linear wellness dedup lookup failed (${err instanceof Error ? err.message : String(err)}) — falling back to GitHub create path`,
    );
    return { kind: 'skipped', reason: 'lookup-failed' };
  }

  if (candidates.length === 0) {
    return { kind: 'skipped', reason: 'no-match' };
  }

  // Prefer the oldest open ticket (lowest QUA number) — matches the GitHub
  // "keep the original, close the rest" convention so both systems converge
  // on the same canonical ticket.
  const open = candidates.filter(isOpen);
  if (open.length > 0) {
    open.sort((a, b) => parseQuaNumber(a.identifier) - parseQuaNumber(b.identifier));
    const target = open[0];
    try {
      await comment(target.identifier, commentBody);
    } catch (err) {
      console.warn(
        `Linear comment on ${target.identifier} failed (${err instanceof Error ? err.message : String(err)}) — falling back to GitHub create path`,
      );
      return { kind: 'skipped', reason: 'lookup-failed' };
    }
    return { kind: 'commented', identifier: target.identifier, url: target.url };
  }

  // No open ticket. Check whether the most recently closed match is still
  // inside the reopen window; if so, reopen + comment rather than filing a
  // brand-new ticket (the failure mode this whole module exists to fix).
  const closed = [...candidates].sort(
    (a, b) =>
      new Date(b.updatedAt ?? b.createdAt).getTime() -
      new Date(a.updatedAt ?? a.createdAt).getTime(),
  );
  const mostRecent = closed[0];
  const mostRecentTs = new Date(mostRecent.updatedAt ?? mostRecent.createdAt).getTime();

  if (!Number.isFinite(mostRecentTs) || now() - mostRecentTs > REOPEN_WINDOW_MS) {
    console.log(
      `Linear wellness dedup: most recent closed match (${mostRecent.identifier}) is outside the ${REOPEN_WINDOW_MS / 3_600_000}h reopen window — filing new ticket`,
    );
    return { kind: 'skipped', reason: 'no-match' };
  }

  try {
    await reopen(mostRecent.identifier, 'Backlog');
    await comment(mostRecent.identifier, commentBody);
  } catch (err) {
    console.warn(
      `Linear reopen of ${mostRecent.identifier} failed (${err instanceof Error ? err.message : String(err)}) — falling back to GitHub create path`,
    );
    return { kind: 'skipped', reason: 'lookup-failed' };
  }
  return { kind: 'reopened', identifier: mostRecent.identifier, url: mostRecent.url };
}

export type CloseLinearWellnessResult =
  | { kind: 'closed'; identifiers: string[] }
  | { kind: 'none' }
  | { kind: 'lookup-failed' };

/**
 * Close any open Linear wellness tickets when the check recovers. Needed
 * because the failure path may comment on a Linear ticket WITHOUT creating
 * a GitHub issue — so the GitHub-mirror close logic would never fire and
 * Linear would be left holding a hanging open ticket.
 */
export async function closeLinearWellnessOnAllClear(
  title: string,
  commentBody: string,
  deps: Partial<LinearDedupDeps> = {},
): Promise<CloseLinearWellnessResult> {
  const { search, comment, reopen } = { ...DEFAULT_DEPS, ...deps };

  let candidates: SearchedIssue[];
  try {
    const results = await search(title, 20);
    candidates = results.filter((r) => r.title === title && isOpen(r));
  } catch (err) {
    console.warn(
      `Linear wellness close lookup failed (${err instanceof Error ? err.message : String(err)})`,
    );
    return { kind: 'lookup-failed' };
  }

  if (candidates.length === 0) return { kind: 'none' };

  const closed: string[] = [];
  for (const issue of candidates) {
    try {
      await comment(issue.identifier, commentBody);
      // `updateIssueState` is shared with the reopen path — same call,
      // different target state.
      await reopen(issue.identifier, 'Done');
      closed.push(issue.identifier);
    } catch (err) {
      console.warn(
        `Failed to close Linear ${issue.identifier}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return closed.length > 0 ? { kind: 'closed', identifiers: closed } : { kind: 'lookup-failed' };
}
