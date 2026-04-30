/**
 * Stale-claim sweep — auto-release Linear tickets whose agent session
 * crashed without producing a feature branch (QUA-815).
 *
 * Tickets get a `🤖 Claude Code starting work` claim comment when an agent
 * runs `crux sys agent-checklist init --linear=QUA-NNN`. If that session
 * subsequently crashes (out-of-context, kernel kill, network drop) before
 * creating `claude/qua-NNN-*` and pushing a PR, the Linear ticket stays
 * "In Progress" indefinitely. The PG `agent_sessions` heartbeat shows the
 * session is dead, but Linear never finds out.
 *
 * The pre-flight check in `dispatched-agent-review.md` then sees "ticket
 * In Progress" and skips dispatching — even though no work is happening.
 * Conversely, if a coordinator dispatches anyway, two sessions can race on
 * the same ticket (the QUA-406 class).
 *
 * This module:
 *   1. Pulls candidate sessions from `GET /api/agent-sessions/stale-claims`
 *      (linear_id IS NOT NULL, status != 'completed', updated_at > 30 min).
 *   2. For each, checks three protective signals — branch exists, open PR
 *      exists, ticket already in a terminal state — before acting. If any
 *      signal fires, the candidate is skipped.
 *   3. For survivors, posts an auto-release comment and moves the ticket to
 *      Backlog. The session row stays as-is (the periodic sweep flips it to
 *      `status='stale'` independently).
 *
 * The branch + open-PR check is the load-bearing piece: it protects long-
 * running parent epics like QUA-408 (data-model unwind) from getting
 * clobbered, since they always have *some* in-flight work even when the
 * parent ticket itself sits "In Progress" for weeks.
 */

import { git } from '../git.ts';
import { githubApi, REPO } from '../github.ts';
import {
  getIssue,
  updateIssueState,
  commentOnIssue,
  type LinearIssue,
} from './issues.ts';
import { getStaleClaims } from '../wiki-server/agent-sessions.ts';

/** A candidate row pulled from `GET /api/agent-sessions/stale-claims`. */
export interface StaleClaim {
  id: number;
  branch: string;
  linearId: string;
  slotNumber: number | null;
  status: string;
  startedAt: string;
  updatedAt: string;
}

/** Outcome for one stale claim after the protective checks run. */
export type ReleaseDecision =
  | { released: true; reason: string }
  | { released: false; reason: string };

export interface ReleaseResult {
  claim: StaleClaim;
  decision: ReleaseDecision;
}

export interface StaleClaimSweepOptions {
  /** Minutes since last heartbeat to count as stale. Default 30. */
  staleMinutes?: number;
  /** Skip the comment + state mutation; only print what would happen. */
  dryRun?: boolean;
  /**
   * Maximum candidates to process in one run. Defaults to 100 — anything
   * larger usually means a sweep regression and is better surfaced as a
   * partial run + escalation than handled silently.
   */
  limit?: number;
  /**
   * Hook so callers (CLI, tests) can stream per-claim progress. Receives the
   * claim plus its decision. The result is reported even when the function
   * returns; the hook is purely incremental.
   */
  onResult?: (result: ReleaseResult) => void;
}

export interface StaleClaimSweepReport {
  candidates: number;
  released: number;
  skipped: number;
  errors: number;
  results: ReleaseResult[];
}

/** Standardized comment body posted on auto-released tickets. */
export const AUTO_RELEASE_COMMENT_PREFIX =
  '🤖 Auto-released claim — session went stale without producing a branch.';

/**
 * Check origin for a `claude/<linear-id-lowercased>(-*)?` branch.
 *
 * Two patterns, not one: `claude/qua-184` (exact) AND `claude/qua-184-*`
 * (with description suffix). A single `claude/qua-184*` glob would
 * false-positive on `claude/qua-1840` and `claude/qua-1840-foo`, so split.
 *
 * We ls-remote against `origin` to avoid a stale local cache misleading the
 * decision: the local clone may not have the branch yet even if the
 * dispatched session pushed one. Returns true iff at least one matching ref
 * is reported.
 */
export function branchExistsForLinearId(
  linearId: string,
  runner: (...args: string[]) => string = git,
): boolean {
  // Normalize to lowercase for the branch pattern. Linear IDs are uppercase
  // (`QUA-184`); branch convention is lowercase (`claude/qua-184-…`). Defend
  // against accidental casing mismatches.
  const slug = linearId.toLowerCase();
  // ls-remote returns one line per matching ref ("<sha>\trefs/heads/<name>")
  // when matches exist, empty string otherwise.
  const out = runner(
    'ls-remote',
    '--heads',
    'origin',
    `claude/${slug}`,
    `claude/${slug}-*`,
  );
  return out.trim().length > 0;
}

/**
 * Find OPEN PRs whose title or body REFERENCES `linearId`. Broader than the
 * audit module's close-keyword filter — for the release-stale check we want
 * to skip on ANY open PR that mentions the ticket, not just ones that
 * explicitly auto-close it. A "follow-up to QUA-NNN" PR should still
 * protect the ticket from being auto-released.
 *
 * Uses GitHub's `/search/issues` endpoint with `is:open is:pr <id>` and
 * client-side verifies the id appears in title or body (defending against
 * GitHub search's tokenization quirks). Not using `searchPRsForIssues` from
 * audit.ts because that one applies a close-keyword filter we don't want
 * here.
 */
export async function findOpenPRsForLinearId(
  linearId: string,
): Promise<Array<{ number: number; url: string; title: string }>> {
  // Allow-list QUA-NNN style ids only — any other format would be a caller
  // bug and we don't want to construct GitHub search queries from
  // arbitrary user input.
  if (!/^[A-Z]+-\d+$/.test(linearId)) {
    throw new Error(`Invalid Linear ID format: ${linearId}`);
  }
  const q = `${linearId} repo:${REPO} is:pr is:open`;
  const encoded = encodeURIComponent(q);
  let resp: GhSearchResponse;
  try {
    resp = await githubApi<GhSearchResponse>(
      `/search/issues?q=${encoded}&per_page=20`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/rate limit exceeded/i.test(msg)) {
      throw new Error(
        `GitHub /search/issues rate limit exceeded (30 req/min). Wait ~60s and re-run.`,
      );
    }
    throw err;
  }
  // Re-verify the id appears in title or body — search uses tokenization
  // and can return PRs that mention adjacent ids (e.g. searching QUA-1
  // returning a PR for QUA-10). Anchor on word boundaries.
  const idRe = new RegExp(`\\b${linearId.replace(/[.*+?^${}()|[\\\]\\\\]/g, '\\$&')}\\b`);
  const matches = resp.items.filter((p) => {
    const haystack = `${p.title}\n${p.body ?? ''}`;
    return idRe.test(haystack);
  });
  return matches.map((p) => ({
    number: p.number,
    url: p.html_url,
    title: p.title,
  }));
}

interface GhSearchItem {
  number: number;
  title: string;
  html_url: string;
  body: string | null;
  state: 'open' | 'closed';
}

interface GhSearchResponse {
  total_count: number;
  items: GhSearchItem[];
}

/**
 * Linear `state.type` values that mean "the ticket is in a terminal state
 * we should not touch." Move-to-Backlog is only safe when the ticket is
 * currently `started` (In Progress / In Review); anything else gets skipped.
 *
 * `triage` is excluded from the auto-release path even though it's
 * technically "open" because we don't know what triage decision is in
 * flight; punting it back to Backlog could erase a human's work.
 */
const NON_RELEASABLE_STATE_TYPES = new Set([
  'completed',  // Done
  'canceled',   // Canceled / Duplicate
  'triage',     // human triage in progress
  'backlog',    // already there — no-op
  'unstarted',  // Todo — already not claimed
]);

/**
 * Decide whether a single stale claim should be released. Returns a decision
 * with a human-readable reason. Does NOT mutate Linear — the caller passes
 * this to `executeRelease()` to apply.
 *
 * Order of checks is intentional: cheapest → most expensive. A branch
 * existence check is local (one git call); the PR search is a GitHub HTTP
 * call; the Linear state check is a Linear GraphQL call. Skip on the
 * cheapest signal first to preserve API budget.
 */
export async function classifyStaleClaim(
  claim: StaleClaim,
): Promise<{ decision: ReleaseDecision; issue?: LinearIssue }> {
  // 1. Local: any matching branch on origin?
  if (branchExistsForLinearId(claim.linearId)) {
    return {
      decision: {
        released: false,
        reason: `branch claude/${claim.linearId.toLowerCase()}-* exists on origin`,
      },
    };
  }

  // 2. GitHub: any open PR auto-closing this ticket?
  const openPRs = await findOpenPRsForLinearId(claim.linearId);
  if (openPRs.length > 0) {
    const refs = openPRs.map((p) => `#${p.number}`).join(', ');
    return {
      decision: {
        released: false,
        reason: `open PR ${refs} references ${claim.linearId}`,
      },
    };
  }

  // 3. Linear: is the ticket actually in a state we should touch?
  const issue = await getIssue(claim.linearId);
  if (!issue) {
    return {
      decision: {
        released: false,
        reason: `Linear ticket ${claim.linearId} not found (deleted?)`,
      },
    };
  }

  if (NON_RELEASABLE_STATE_TYPES.has(issue.state.type)) {
    return {
      decision: {
        released: false,
        reason: `state is ${issue.state.name} (type=${issue.state.type}) — not eligible`,
      },
    };
  }

  return {
    decision: {
      released: true,
      reason: `stale ${humanizeStaleAge(claim.updatedAt)}, no branch, no open PR, state=${issue.state.name}`,
    },
    issue,
  };
}

/**
 * Apply the release: post the auto-release comment, then move the ticket to
 * Backlog. The comment is posted FIRST so the audit trail captures the
 * reason even if the state-change call fails (the next sweep will retry the
 * state move).
 */
export async function executeRelease(
  claim: StaleClaim,
  reason: string,
): Promise<void> {
  const body =
    `${AUTO_RELEASE_COMMENT_PREFIX} Re-claim if still relevant.\n\n` +
    `**Detected by:** \`crux linear release-stale\`\n` +
    `**Session row:** id=${claim.id}, branch=\`${claim.branch}\`, slot=${claim.slotNumber !== null ? `a${claim.slotNumber}` : '(none)'}\n` +
    `**Last heartbeat:** ${claim.updatedAt}\n` +
    `**Reason:** ${reason}`;
  await commentOnIssue(claim.linearId, body);
  await updateIssueState(claim.linearId, 'Backlog');
}

/**
 * Render an updatedAt ISO string as a coarse "Nd"/"Nh"/"Nm" duration. Used
 * in human-readable reasons; not a substitute for the raw timestamp.
 */
export function humanizeStaleAge(updatedAt: string): string {
  const ms = Date.now() - new Date(updatedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return updatedAt;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/**
 * Run the full stale-claim sweep: query candidates, classify each, and
 * release the eligible ones (unless `dryRun`). Returns a structured report
 * the CLI uses for the summary print and exit code.
 *
 * Failures classifying or releasing one claim do NOT abort the run — they
 * count toward the `errors` total in the report. The next sweep retries.
 */
export async function runStaleClaimSweep(
  options: StaleClaimSweepOptions = {},
): Promise<StaleClaimSweepReport> {
  const staleMinutes = options.staleMinutes ?? 30;
  const limit = options.limit ?? 100;
  const dryRun = options.dryRun ?? false;

  const claimsResp = await getStaleClaims(staleMinutes);
  if (!claimsResp.ok) {
    throw new Error(
      `Failed to fetch stale claims from wiki-server: ${claimsResp.message}`,
    );
  }

  const candidates: StaleClaim[] = claimsResp.data.sessions
    .filter((s): s is StaleClaim & { linearId: string } => s.linearId !== null)
    .slice(0, limit)
    .map((s) => ({
      id: s.id,
      branch: s.branch,
      linearId: s.linearId,
      slotNumber: s.slotNumber,
      status: s.status,
      startedAt: typeof s.startedAt === 'string' ? s.startedAt : new Date(s.startedAt).toISOString(),
      updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : new Date(s.updatedAt).toISOString(),
    }));

  const results: ReleaseResult[] = [];
  let released = 0;
  let skipped = 0;
  let errors = 0;

  for (const claim of candidates) {
    let result: ReleaseResult;
    try {
      const { decision } = await classifyStaleClaim(claim);
      if (decision.released && !dryRun) {
        await executeRelease(claim, decision.reason);
      }
      result = { claim, decision };
      if (decision.released) released += 1;
      else skipped += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = {
        claim,
        decision: {
          released: false,
          reason: `error during classification/release: ${msg}`,
        },
      };
      errors += 1;
    }
    results.push(result);
    options.onResult?.(result);
  }

  return {
    candidates: candidates.length,
    released,
    skipped,
    errors,
    results,
  };
}
