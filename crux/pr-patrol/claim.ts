/**
 * PR Patrol — Claim/release primitives
 *
 * Shared helpers for acquiring and releasing the `pr-patrol:working` label
 * on a PR. Used by both the serial (execution.ts) and parallel (parallel.ts)
 * dispatch paths.
 *
 * ## The critical race these helpers fix (QUA-400)
 *
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
 * This shrinks the race window from ~12s (the rebase/verify round-trip) to
 * a single sub-second API call (`fetchLabels` → `addWorkingLabel`).
 *
 * ## Residual TOCTOU race — KNOWN LIMITATION (tracked in QUA-494)
 *
 * `tryClaimPr()` does a pre-check of existing working labels and adds the
 * `pr-patrol:working` label if the PR is unclaimed. **This is not atomic.**
 * GitHub's add-labels endpoint is idempotent and has no "add-if-absent"
 * primitive, so two workers whose `fetchLabels` calls both return
 * "unclaimed" within the same sub-second window will both proceed to
 * `addWorkingLabel` and both receive a `didClaim === true`. When either
 * later calls `releasePrIfClaimed`, it removes the single shared
 * `pr-patrol:working` label — including the other worker's claim.
 *
 * This was flagged as a Major finding in PR #4362 CodeRabbit review. The
 * `didClaim` gate remains a **best-effort guard**, not a proof of
 * ownership. Fixing it properly requires either (a) per-worker ownership
 * metadata via a hidden PR claim comment, or (b) per-worker label names.
 * Both options are substantial scaffolding for a sub-second race window,
 * so they're tracked as a follow-up rather than inlined into the critical
 * fix.
 *
 * **Tracked in:** https://linear.app/quantifieduncertainty/issue/QUA-494
 *
 * Until QUA-494 lands, accept that two concurrent patrol workers on the
 * same PR within a sub-second window *can* both remove the shared label.
 * The consequence is that the PR re-enters the detection pool and the
 * still-running worker's state is eventually reconciled by the stale-label
 * health check in `crux/health/checks/pr-quality.ts` (>8h stuck label).
 */

import { githubApi, isGitHubApiErrorWithStatus } from '../lib/github.ts';
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
 *
 * ## Client-side timeout on a server-side success (QUA-400 Major fix)
 *
 * When `addWorkingLabel` throws, we cannot assume the POST failed
 * server-side — a connection reset or client timeout can fire AFTER
 * GitHub has already applied the label. If we returned `false` in that
 * case, the finally-release would be a no-op and the label would leak
 * permanently, blocking future claims on this PR.
 *
 * Recovery: re-query the PR's labels.
 *   - If our label is now present → return `true` (the POST succeeded
 *     server-side; we own the claim).
 *   - If the re-query confirms the label is absent → return `false` (the
 *     POST really did fail).
 *   - If the re-query itself also fails → return `true` (fail-safe:
 *     assume we may own the label so the finally-release cleans it up.
 *     A double-release is harmless because DELETE is idempotent on 404,
 *     but a missed release would leak the label).
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
  } catch (addErr) {
    // CodeRabbit QUA-400 Major finding: a POST can fail client-side AFTER
    // GitHub has already applied the label — e.g. a connection reset or
    // timeout after the server processed the request. Treating every
    // add-label failure as `didClaim === false` and then no-op'ing release
    // would leak the label permanently, blocking future claim attempts on
    // this PR.
    //
    // Recovery strategy: re-query labels. If our label is now present, the
    // POST succeeded server-side despite the client error — treat it as a
    // successful claim. If the re-query ALSO fails, choose fail-safe: assume
    // didClaim=true so the finally block releases the label. This can cause
    // a harmless double-release (the label may actually not be ours, or the
    // DELETE hits a 404 because the label was never applied), but delete is
    // idempotent on 404 and a double-release is strictly better than a
    // permanent label leak.
    const addErrMsg = addErr instanceof Error ? addErr.message : String(addErr);
    let postCheckLabels: string[];
    try {
      postCheckLabels = await deps.fetchLabels(prNumber, repo);
    } catch (reCheckErr) {
      // Re-query failed. Fail-safe: assume the POST may have succeeded and
      // we own the label. The finally release will clean it up; delete is
      // idempotent on 404 so this can't leak.
      const reCheckMsg =
        reCheckErr instanceof Error ? reCheckErr.message : String(reCheckErr);
      deps.onClaimLost?.(
        prNumber,
        `label write failed (${addErrMsg}); post-write re-check ` +
          `also failed (${reCheckMsg}); assuming didClaim=true fail-safe ` +
          'to avoid label leak',
      );
      return true;
    }

    if (postCheckLabels.includes(LABELS.PR_PATROL_WORKING)) {
      // The POST succeeded server-side despite the client-side error.
      // Treat it as a successful claim.
      deps.onClaimLost?.(
        prNumber,
        `label write threw (${addErrMsg}) but post-write re-check shows ` +
          'label is present; treating as successful claim',
      );
      return true;
    }

    // Re-query succeeded and confirmed the label is NOT present. The POST
    // really did fail; we did not claim. Safe to return false.
    deps.onClaimLost?.(
      prNumber,
      `label write failed: ${addErrMsg}`,
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
 *
 * ⚠ **Known residual TOCTOU race (QUA-494)**: the `didClaim` boolean
 * is a best-effort guard, not a proof of ownership. If two workers won
 * the initial `tryClaimPr` race (both saw "unclaimed" in their
 * pre-check and both added the label), they will both reach this
 * function with `didClaim === true`, and each call will remove the
 * single shared `pr-patrol:working` label — clobbering the other
 * worker's claim. See the module JSDoc for the full explanation and
 * https://linear.app/quantifieduncertainty/issue/QUA-494 for the
 * follow-up that replaces this with worker-specific ownership
 * metadata (hidden PR claim comments or per-worker label names).
 *
 * The sub-second race window is much smaller than the ~12s window
 * this function's existence originally fixed (QUA-400), but it is not
 * zero and PR reviewers (particularly CodeRabbit) have flagged it as
 * a Major finding. Do not remove the `didClaim` gate — it's correct
 * on the success path; the known gap is only when two workers
 * concurrently "win" the pre-check.
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
 * Default remove-label implementation. Swallows ONLY a concrete HTTP 404
 * (label already absent) and re-throws every other error so a stale
 * `pr-patrol:working` label can't silently block future scans of this PR.
 *
 * CodeRabbit QUA-400 follow-up: this was previously keyed off
 * `msg.includes('404') || msg.includes('Not Found')`, which would also
 * swallow a 500 whose response body happened to contain those substrings
 * (e.g. a PR number, a URL path, or a helpful error message). That meant
 * a real server failure could be reported as "label already gone" and the
 * working label would remain stuck, preventing the PR from being picked
 * up by future patrol cycles. Keying off the structured `.status` on
 * {@link GitHubApiError} narrows the swallow to the one case we actually
 * want to tolerate.
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
    // Only swallow a concrete HTTP 404 — the label was already removed,
    // either by a concurrent worker's release or by a manual /labels DELETE.
    // Any other error (500, 403, network failure) must bubble so callers
    // can surface a stale working label.
    if (isGitHubApiErrorWithStatus(e, 404)) {
      return;
    }
    throw e;
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
