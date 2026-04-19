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
 *
 * Trade-off documented: a sustained Linear outage (where `searchIssues`
 * always throws) defeats the dedup and lets every wellness run create a
 * new GitHub issue → new Linear mirror. The alternative is to block
 * wellness reporting entirely during a Linear outage, which is strictly
 * worse — GitHub outages would also halt reporting even though the
 * wellness-check data is still valuable. Accept the occasional burst.
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

/**
 * Linear workflow-state `type` values that represent an actively-tracked
 * (non-terminal) ticket. Use an allowlist rather than a denylist so any
 * unknown/future state type (`triage`, custom types, etc.) fails safe as
 * "don't treat as open" — accidentally commenting on a terminal ticket
 * is worse than letting one slip through and file a fresh one.
 */
const OPEN_STATE_TYPES = new Set(['backlog', 'unstarted', 'started', 'triage']);

export type LinearWellnessAction =
  | { kind: 'commented'; identifier: string; url: string }
  | { kind: 'reopened'; identifier: string; url: string }
  | { kind: 'skipped'; reason: 'no-match' | 'lookup-failed' };

export interface LinearDedupDeps {
  search: typeof searchIssues;
  comment: typeof commentOnIssue;
  /**
   * Underlying state transition. Named after the generic `updateIssueState`
   * it wraps rather than "reopen" or "close" because this module uses it
   * for both transitions (Backlog on reopen, Done on all-clear close).
   */
  setState: typeof updateIssueState;
  now: () => number;
}

const DEFAULT_DEPS: LinearDedupDeps = {
  search: searchIssues,
  comment: commentOnIssue,
  setState: updateIssueState,
  now: Date.now,
};

function parseQuaNumber(identifier: string): number {
  const m = identifier.match(/^QUA-(\d+)$/);
  return m ? Number(m[1]) : 0;
}

function isOpen(issue: SearchedIssue): boolean {
  return OPEN_STATE_TYPES.has(issue.state.type);
}

function issueTimestampMs(issue: SearchedIssue): number {
  return new Date(issue.updatedAt ?? issue.createdAt).getTime();
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
  const { search, comment, setState, now } = { ...DEFAULT_DEPS, ...deps };

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
  // Sort only the CLOSED candidates (the early-return above guarantees
  // `open` is empty here, but an explicit filter keeps intent local to the
  // block in case the guard is ever refactored).
  const closedCandidates = candidates
    .filter((c) => !isOpen(c))
    .sort((a, b) => issueTimestampMs(b) - issueTimestampMs(a));
  const mostRecent = closedCandidates[0];
  const mostRecentTs = issueTimestampMs(mostRecent);

  if (!Number.isFinite(mostRecentTs) || now() - mostRecentTs > REOPEN_WINDOW_MS) {
    console.log(
      `Linear wellness dedup: most recent closed match (${mostRecent.identifier}) is outside the ${REOPEN_WINDOW_MS / 3_600_000}h reopen window — filing new ticket`,
    );
    return { kind: 'skipped', reason: 'no-match' };
  }

  // Reopen first. Once the state transition lands, the ticket IS canonically
  // the target of the recurrence — even if the follow-up comment fails, we
  // must NOT fall through to the GitHub create path (that's the exact
  // duplicate-creation bug QUA-577 fixes). The comment is best-effort
  // decoration; the state transition is the dedup action.
  try {
    await setState(mostRecent.identifier, 'Backlog');
  } catch (err) {
    console.warn(
      `Linear reopen of ${mostRecent.identifier} failed (${err instanceof Error ? err.message : String(err)}) — falling back to GitHub create path`,
    );
    return { kind: 'skipped', reason: 'lookup-failed' };
  }
  // Reopen succeeded — the rest is cosmetic. A comment failure here MUST NOT
  // propagate as `skipped` (see the test in wellness-linear-dedup.test.ts
  // titled "returns reopened (NOT skipped) when reopen succeeds but comment
  // throws").
  await comment(mostRecent.identifier, commentBody).catch((err) => {
    console.warn(
      `Linear comment on reopened ${mostRecent.identifier} failed (${err instanceof Error ? err.message : String(err)}); ticket is already reopened, skipping GitHub create`,
    );
  });
  return { kind: 'reopened', identifier: mostRecent.identifier, url: mostRecent.url };
}

export type CloseLinearWellnessResult =
  | { kind: 'closed'; identifiers: string[] }
  | { kind: 'none' }
  /** Discriminates "didn't reach Linear" from "reached Linear but every close call threw." */
  | { kind: 'lookup-failed' }
  | { kind: 'close-failed'; attempted: string[] };

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
  const { search, comment, setState } = { ...DEFAULT_DEPS, ...deps };

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
  const attempted: string[] = [];
  for (const issue of candidates) {
    attempted.push(issue.identifier);
    try {
      await comment(issue.identifier, commentBody);
      await setState(issue.identifier, 'Done');
      closed.push(issue.identifier);
    } catch (err) {
      console.warn(
        `Failed to close Linear ${issue.identifier}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (closed.length > 0) return { kind: 'closed', identifiers: closed };
  return { kind: 'close-failed', attempted };
}
