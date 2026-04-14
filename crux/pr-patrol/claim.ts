/**
 * PR Patrol — Claim/release primitives
 *
 * Shared helpers for acquiring and releasing the `pr-patrol:working` label
 * on a PR. Used by both the serial (execution.ts) and parallel (parallel.ts)
 * dispatch paths.
 *
 * The claim-race bug these helpers fix (QUA-400 CodeRabbit critical review):
 * Previously each path ran `tryRebaseAndVerify()` (which polls GitHub for
 * ~12s) BEFORE adding the working label. During that window another patrol
 * process could claim the PR, and the unconditional `releasePr()` in the
 * `finally` block would then delete the other worker's label, leaving both
 * workers racing on the same PR.
 *
 * The fix:
 *   1. Claim BEFORE the rebase/verify round-trip.
 *   2. Track whether THIS worker actually acquired the claim (`didClaim`).
 *   3. Only release the label in `finally` when `didClaim === true`.
 *
 * `tryClaimPr()` does a pre-check of existing working labels and adds the
 * `pr-patrol:working` label if the PR is unclaimed. It returns `didClaim`
 * so the caller can gate the release. TOCTOU note: GitHub's add-labels
 * endpoint is idempotent and has no atomic "add-if-absent" primitive, so
 * two workers arriving within the same sub-second window can both believe
 * they own the claim. That residual race is bounded by a *single* API
 * call instead of a ~12s rebase/verify round-trip, which is what the
 * CodeRabbit finding flagged as critical.
 */

import { githubApi } from '../lib/github.ts';
import { ANY_WORKING_LABELS } from '../lib/labels.ts';
import { LABELS } from './types.ts';

/** Dependencies injected so tests can substitute a fake GitHub client. */
export interface ClaimDeps {
  /** Fetch an issue's labels. Returns the list of label names. */
  fetchLabels: (prNumber: number, repo: string) => Promise<string[]>;
  /** Add the `pr-patrol:working` label to a PR. May throw on network error. */
  addWorkingLabel: (prNumber: number, repo: string) => Promise<void>;
  /** Remove the `pr-patrol:working` label. Should swallow 404 (already gone). */
  removeWorkingLabel: (prNumber: number, repo: string) => Promise<void>;
  /** Optional callback for logging / side effects on claim events. */
  onClaimLost?: (prNumber: number, reason: string) => void;
}

/**
 * Attempt to claim a PR for this worker.
 *
 * Returns `true` if this worker successfully added the working label (the
 * PR was unclaimed at check time). Returns `false` if another worker holds
 * a working label, in which case the caller must NOT call `releasePr()` —
 * otherwise it will delete the other worker's claim.
 *
 * Throws only on unrecoverable pre-check errors (e.g., caller invariants).
 * Network/API errors during the label write are treated as "unable to
 * claim" (returns false) so the caller bails out cleanly.
 */
export async function tryClaimPr(
  prNumber: number,
  repo: string,
  deps: ClaimDeps,
): Promise<boolean> {
  // Pre-check: is anyone else already working on this PR?
  let labels: string[];
  try {
    labels = await deps.fetchLabels(prNumber, repo);
  } catch (e) {
    // If we can't read labels, we can't safely acquire — bail out.
    // (Historically execution.ts's `isPrStillAvailable` swallowed this
    // and proceeded optimistically. For claim ownership we must fail
    // closed: without a successful pre-check we don't know who owns
    // the PR, so we shouldn't release a label we may not have set.)
    deps.onClaimLost?.(
      prNumber,
      `pre-check failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }

  const held = ANY_WORKING_LABELS.find((wl) => labels.includes(wl));
  if (held) {
    deps.onClaimLost?.(
      prNumber,
      `already claimed by another worker (label: ${held})`,
    );
    return false;
  }

  // No existing claim — attempt to add our working label.
  try {
    await deps.addWorkingLabel(prNumber, repo);
  } catch (e) {
    deps.onClaimLost?.(
      prNumber,
      `label write failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }

  return true;
}

/**
 * Release this worker's claim on a PR.
 *
 * **Callers MUST gate this on `didClaim === true`** from a successful
 * `tryClaimPr()` call. Calling `releasePrIfClaimed(didClaim, ...)` when
 * `didClaim === false` is a no-op — it won't touch the label, which is
 * exactly what we want when another worker holds it.
 */
export async function releasePrIfClaimed(
  didClaim: boolean,
  prNumber: number,
  repo: string,
  deps: Pick<ClaimDeps, 'removeWorkingLabel'>,
): Promise<void> {
  if (!didClaim) return;
  await deps.removeWorkingLabel(prNumber, repo);
}

// ── Default production implementations ──────────────────────────────────────

/** Default label-fetch implementation backed by the GitHub REST API. */
export async function defaultFetchLabels(
  prNumber: number,
  repo: string,
): Promise<string[]> {
  const pr = await githubApi<{ labels: Array<{ name: string }> }>(
    `/repos/${repo}/issues/${prNumber}`,
  );
  return pr.labels.map((l) => l.name);
}

/** Default add-label implementation. */
export async function defaultAddWorkingLabel(
  prNumber: number,
  repo: string,
): Promise<void> {
  await githubApi(`/repos/${repo}/issues/${prNumber}/labels`, {
    method: 'POST',
    body: { labels: [LABELS.PR_PATROL_WORKING] },
  });
}

/**
 * Default remove-label implementation. Swallows 404 (label already absent)
 * but surfaces other errors so a stale `pr-patrol:working` label can't
 * silently block future scans of this PR.
 */
export async function defaultRemoveWorkingLabel(
  prNumber: number,
  repo: string,
): Promise<void> {
  try {
    await githubApi(
      `/repos/${repo}/issues/${prNumber}/labels/${encodeURIComponent(
        LABELS.PR_PATROL_WORKING,
      )}`,
      { method: 'DELETE' },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('404') && !msg.includes('Not Found')) {
      throw e;
    }
  }
}

/** Build a ClaimDeps using the default production GitHub client. */
export function defaultClaimDeps(
  onClaimLost?: (prNumber: number, reason: string) => void,
): ClaimDeps {
  return {
    fetchLabels: defaultFetchLabels,
    addWorkingLabel: defaultAddWorkingLabel,
    removeWorkingLabel: defaultRemoveWorkingLabel,
    onClaimLost,
  };
}
