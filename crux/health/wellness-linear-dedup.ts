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
  createIssue as createLinearIssueRaw,
  updateIssueState,
  type SearchedIssue,
} from '../lib/linear/issues.ts';
import { getProject } from '../lib/linear/projects.ts';
import { isOpenStateType } from '../lib/linear/workflow-states.ts';

/**
 * Project that owns wellness tickets. Past wellness tickets (QUA-577,
 * QUA-676, QUA-590, QUA-607) all live here, so new ones land alongside them.
 * Per `docs/agent-rules/linear-project-ownership.md`, Automation & Infrastructure
 * owns "scheduled jobs" — wellness checks are scheduled health monitors.
 */
export const WELLNESS_PROJECT_NAME = 'Automation & Infrastructure';

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
  | { kind: 'skipped'; reason: 'no-match' | 'lookup-failed' | 'misconfig' };

/**
 * Detect the specific error thrown by `getLinearApiKey()` when LINEAR_API_KEY
 * is unset in the env. This is a permanent misconfiguration (vs a transient
 * Linear API outage), so the caller surfaces it loudly instead of silently
 * falling through to the GitHub create path. The check is substring-based so
 * it survives wrapping in additional error context — `getLinearApiKey()`'s
 * exact message is "LINEAR_API_KEY not set. Required for Linear API calls."
 */
export function isMissingLinearApiKeyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('LINEAR_API_KEY not set');
}

export interface LinearDedupDeps {
  search: typeof searchIssues;
  comment: typeof commentOnIssue;
  /**
   * Underlying state transition. Named after the generic `updateIssueState`
   * it wraps rather than "reopen" or "close" because this module uses it
   * for both transitions (Backlog on reopen, Done on all-clear close).
   */
  setState: typeof updateIssueState;
  /**
   * Linear issue creation + project lookup, used by the new
   * `createLinearWellnessIssue` Linear-first path. Bundled into the same
   * deps interface (rather than its own type) so tests inject one
   * `linearDedupDeps` object instead of two.
   */
  createIssue: typeof createLinearIssueRaw;
  getProject: typeof getProject;
  now: () => number;
}

const DEFAULT_DEPS: LinearDedupDeps = {
  search: searchIssues,
  comment: commentOnIssue,
  setState: updateIssueState,
  createIssue: createLinearIssueRaw,
  getProject,
  now: Date.now,
};

function parseQuaNumber(identifier: string): number {
  const m = identifier.match(/^QUA-(\d+)$/);
  return m ? Number(m[1]) : 0;
}

function isOpen(issue: SearchedIssue): boolean {
  return isOpenStateType(issue.state.type);
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
    if (isMissingLinearApiKeyError(err)) {
      // Permanent misconfig — surfaced via stdout because GitHub Actions
      // workflow commands (::error::) are parsed only from stdout. The caller
      // also stamps a banner onto the GitHub issue body so the cause is
      // visible to whoever reads the wellness ticket.
      console.log(
        '::error title=Wellness dedup misconfigured::LINEAR_API_KEY secret not set in repo — Linear-side dedup is dormant; expect duplicate wellness tickets until the secret is added (Settings → Secrets and variables → Actions).',
      );
      return { kind: 'skipped', reason: 'misconfig' };
    }
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
    // The open ticket's EXISTENCE is the dedup signal; the comment is
    // cosmetic decoration. A comment failure must NOT fall through to the
    // GitHub create path — that would mirror into a second Linear ticket
    // and reintroduce the duplicate-cascade this module prevents.
    await comment(target.identifier, commentBody).catch((err) => {
      console.warn(
        `Linear comment on ${target.identifier} failed (${err instanceof Error ? err.message : String(err)}); ticket is already open, skipping GitHub create`,
      );
    });
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
  /** Permanent misconfig: LINEAR_API_KEY missing. Distinguished so the all-clear path stays quiet — there's nothing to close on Linear when we never opened anything there. */
  | { kind: 'misconfig' }
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
    if (isMissingLinearApiKeyError(err)) {
      // All-clear path stays quiet on misconfig — the failure path already
      // emitted the loud ::error banner; no point repeating it on every
      // recovery cycle.
      return { kind: 'misconfig' };
    }
    console.warn(
      `Linear wellness close lookup failed (${err instanceof Error ? err.message : String(err)})`,
    );
    return { kind: 'lookup-failed' };
  }

  if (candidates.length === 0) return { kind: 'none' };

  // Close in parallel. Typically 0–3 candidates; Linear API calls are
  // independent. Promise.allSettled preserves partial-success semantics
  // without tangling the sequential-loop error plumbing.
  const results = await Promise.allSettled(
    candidates.map(async (issue) => {
      await comment(issue.identifier, commentBody);
      await setState(issue.identifier, 'Done');
      return issue.identifier;
    }),
  );
  const closed = results.flatMap((r, i) => {
    if (r.status === 'fulfilled') return [r.value];
    console.warn(
      `Failed to close Linear ${candidates[i].identifier}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
    );
    return [];
  });
  if (closed.length > 0) return { kind: 'closed', identifiers: closed };
  return { kind: 'close-failed', attempted: candidates.map((c) => c.identifier) };
}

export type CreateLinearWellnessResult =
  | { kind: 'created'; identifier: string; url: string }
  /** LINEAR_API_KEY missing — caller should fall back to GitHub create with the misconfig banner. */
  | { kind: 'failed'; reason: 'misconfig'; error: string }
  /** Project name didn't resolve, OR the create call threw. Caller should fall back to GitHub. */
  | { kind: 'failed'; reason: 'project-missing' | 'api-error'; error: string };

/**
 * Create a new Linear wellness ticket (QUA-970). Replaces the legacy GitHub
 * create path: instead of letting Linear's GitHub-mirror integration produce
 * an orphan synced ticket, this files directly into Linear with the right
 * project (so it doesn't show up as orphaned in `crux linear hygiene`).
 *
 * Returns a discriminated union so the caller can decide whether to fall
 * back to GitHub. The fallback path is preserved for resilience: if Linear
 * is misconfigured or unreachable we still want the alert recorded SOMEWHERE.
 */
export async function createLinearWellnessIssue(
  title: string,
  body: string,
  deps: Partial<LinearDedupDeps> = {},
): Promise<CreateLinearWellnessResult> {
  const { createIssue, getProject: _getProject } = { ...DEFAULT_DEPS, ...deps };

  let projectId: string;
  try {
    const project = await _getProject(WELLNESS_PROJECT_NAME);
    if (!project) {
      // Project missing is a config drift on Linear's side, not the same as
      // a missing API key. Surfaced as a separate reason so the caller logs
      // it loudly rather than treating it as a transient blip.
      const error = `Linear project "${WELLNESS_PROJECT_NAME}" not found — has it been renamed? Falling back to GitHub create.`;
      console.warn(error);
      return { kind: 'failed', reason: 'project-missing', error };
    }
    projectId = project.id;
  } catch (err) {
    if (isMissingLinearApiKeyError(err)) {
      const error = err instanceof Error ? err.message : String(err);
      return { kind: 'failed', reason: 'misconfig', error };
    }
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`Linear project lookup failed (${error}) — falling back to GitHub create`);
    return { kind: 'failed', reason: 'api-error', error };
  }

  try {
    const result = await createIssue({
      title,
      description: body,
      projectId,
    });
    return { kind: 'created', identifier: result.identifier, url: result.url };
  } catch (err) {
    if (isMissingLinearApiKeyError(err)) {
      const error = err instanceof Error ? err.message : String(err);
      return { kind: 'failed', reason: 'misconfig', error };
    }
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`Linear wellness create failed (${error}) — falling back to GitHub create`);
    return { kind: 'failed', reason: 'api-error', error };
  }
}
