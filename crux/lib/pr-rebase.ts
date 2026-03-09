/**
 * PR Rebase Logic
 *
 * Automatically rebases open non-draft PRs onto main, with safeguards
 * to avoid disrupting active agent work.
 *
 * Safeguards:
 *   1. Skip PRs with any working label (`agent:working`, `pr-patrol:working`)
 *   2. Skip PRs updated within 30 minutes (active work)
 *   3. Skip branches with commits pushed within 30 minutes (active work)
 *   4. Skip branches where the last commit message contains `[ci-autofix]` (feedback loop)
 *   5. Skip PRs with the `stage:merging` label (in merge queue — rebase would invalidate entry)
 *
 * Used by: crux pr rebase-all (CLI command) and .github/workflows/auto-rebase.yml
 */

import { git, gitSafe, isValidBranchName, commitEpoch, commitSubject, pushWithRetry, revParse, configBotUser } from './git.ts';
import { githubApi, REPO } from './github.ts';
import { LABELS, ANY_WORKING_LABELS } from './labels.ts';

// ── Types ────────────────────────────────────────────────────────────────────

export interface RebaseCandidate {
  number: number;
  branch: string;
  updatedAt: string;
  labels: string[];
}

export interface RebaseResult {
  number: number;
  branch: string;
  status: 'rebased' | 'up-to-date' | 'skipped' | 'conflict' | 'push-failed';
  reason?: string;
}

// ── GitHub API response types ────────────────────────────────────────────────

interface GitHubPRListItem {
  number: number;
  head: { ref: string };
  isDraft?: boolean;
  draft?: boolean;
  updated_at: string;
  labels: Array<{ name: string }>;
}

// ── Default constants ────────────────────────────────────────────────────────

const DEFAULT_RECENT_WINDOW = 1800; // 30 minutes in seconds

// ── Pure skip logic (exported for testing) ───────────────────────────────────

/**
 * Determine whether a PR should be skipped for rebase.
 *
 * Encapsulates all 5 safeguards:
 *   1. Any working label (`agent:working`, `pr-patrol:working`)
 *   2. PR updated within recentWindow
 *   3. Branch tip pushed within recentWindow
 *   4. Last commit message contains `[ci-autofix]`
 *   5. `stage:merging` label (in merge queue — rebase would invalidate entry)
 *
 * @param pr - The PR candidate
 * @param nowEpoch - Current time as Unix epoch seconds
 * @param branchTipEpoch - Unix epoch seconds of the branch tip commit
 * @param lastCommitMessage - Subject line of the most recent commit on the branch
 * @param recentWindow - Number of seconds defining "recent" activity (default: 1800)
 * @returns { skip: true, reason: string } if the PR should be skipped, or { skip: false }
 */
export function shouldSkipPr(
  pr: RebaseCandidate,
  nowEpoch: number,
  branchTipEpoch: number,
  lastCommitMessage: string,
  recentWindow: number,
): { skip: boolean; reason?: string } {
  // Safeguard 1: any working label (agent:working, pr-patrol:working)
  const workingLabel = ANY_WORKING_LABELS.find((wl) => pr.labels.includes(wl));
  if (workingLabel) {
    return { skip: true, reason: `has '${workingLabel}' label (actively being worked on)` };
  }

  // Safeguard 5: stage:merging label (in merge queue — rebase would invalidate entry)
  if (pr.labels.includes(LABELS.STAGE_MERGING)) {
    return { skip: true, reason: `has '${LABELS.STAGE_MERGING}' label (in merge queue)` };
  }

  // Safeguard 2: PR updated recently
  const prUpdatedEpoch = Math.floor(new Date(pr.updatedAt).getTime() / 1000);
  const prAge = nowEpoch - prUpdatedEpoch;
  if (prAge < recentWindow) {
    return { skip: true, reason: `PR updated ${prAge}s ago (within ${recentWindow}s window)` };
  }

  // Safeguard 3: Branch tip pushed recently
  const branchAge = nowEpoch - branchTipEpoch;
  if (branchAge < recentWindow) {
    return { skip: true, reason: `branch tip is ${branchAge}s old (within ${recentWindow}s window)` };
  }

  // Safeguard 4: Last commit is ci-autofix
  if (/\[ci-autofix\]/i.test(lastCommitMessage)) {
    return { skip: true, reason: 'most recent commit is a ci-autofix commit (feedback-loop risk)' };
  }

  return { skip: false };
}

// ── Main orchestrator ────────────────────────────────────────────────────────

/**
 * Rebase all open non-draft PRs targeting main onto the latest main.
 *
 * @param options.recentWindowSeconds - Override the 30-minute recent-activity window (seconds)
 * @param options.verbose - Print detailed progress to stdout
 * @returns Summary of results and number of failures
 */
export async function rebaseAllPrs(options: {
  recentWindowSeconds?: number;
  verbose?: boolean;
} = {}): Promise<{ results: RebaseResult[]; failed: number }> {
  const { recentWindowSeconds = DEFAULT_RECENT_WINDOW, verbose = false } = options;
  const log = verbose ? console.log : () => {};

  // Configure bot identity for commits
  configBotUser();

  const nowEpoch = Math.floor(Date.now() / 1000);

  // Fetch all open non-draft PRs targeting main
  const prs = await githubApi<GitHubPRListItem[]>(
    `/repos/${REPO}/pulls?base=main&state=open&per_page=100`
  );

  // Filter out drafts
  const candidates: RebaseCandidate[] = prs
    .filter((pr) => !(pr.isDraft ?? pr.draft))
    .map((pr) => ({
      number: pr.number,
      branch: pr.head.ref,
      updatedAt: pr.updated_at,
      labels: pr.labels.map((l) => l.name),
    }));

  if (candidates.length === 0) {
    log('No open non-draft PRs to rebase.');
    return { results: [], failed: 0 };
  }

  log(`Found ${candidates.length} open non-draft PR(s) targeting main.`);

  const results: RebaseResult[] = [];
  let failed = 0;

  // Save the current HEAD so we can return to a clean state between PRs
  const originalHead = revParse('HEAD');

  for (const pr of candidates) {
    log(`\n--- PR #${pr.number} (${pr.branch}) ---`);

    // Validate branch name
    if (!isValidBranchName(pr.branch)) {
      log(`  Skipping — invalid branch name.`);
      results.push({ number: pr.number, branch: pr.branch, status: 'skipped', reason: 'invalid branch name' });
      continue;
    }

    // Fetch the branch
    const fetchResult = gitSafe('fetch', 'origin', pr.branch);
    if (!fetchResult.ok) {
      log(`  Skipping — could not fetch branch (may be from a fork).`);
      results.push({ number: pr.number, branch: pr.branch, status: 'skipped', reason: 'could not fetch branch (may be from a fork)' });
      continue;
    }

    // Get branch tip info for safeguard checks
    let branchTipEpoch: number;
    let lastCommitMsg: string;
    try {
      branchTipEpoch = commitEpoch(`origin/${pr.branch}`);
      lastCommitMsg = commitSubject(`origin/${pr.branch}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`  Skipping — could not read branch tip: ${msg}`);
      results.push({ number: pr.number, branch: pr.branch, status: 'skipped', reason: `could not read branch tip: ${msg}` });
      continue;
    }

    // Apply skip safeguards
    const skipCheck = shouldSkipPr(pr, nowEpoch, branchTipEpoch, lastCommitMsg, recentWindowSeconds);
    if (skipCheck.skip) {
      log(`  Skipping — ${skipCheck.reason}`);
      results.push({ number: pr.number, branch: pr.branch, status: 'skipped', reason: skipCheck.reason });
      continue;
    }

    // Checkout the branch for rebasing
    gitSafe('checkout', '--detach', 'origin/main');
    const checkoutResult = gitSafe('checkout', '-B', pr.branch, `origin/${pr.branch}`);
    if (!checkoutResult.ok) {
      log(`  Skipping — could not checkout branch: ${checkoutResult.stderr}`);
      results.push({ number: pr.number, branch: pr.branch, status: 'skipped', reason: `checkout failed: ${checkoutResult.stderr}` });
      continue;
    }

    // Attempt rebase
    const rebaseResult = gitSafe('rebase', 'origin/main');
    if (!rebaseResult.ok) {
      // Rebase conflicts — abort and continue
      gitSafe('rebase', '--abort');
      log(`  Conflicts detected — leaving for conflict resolver.`);
      results.push({ number: pr.number, branch: pr.branch, status: 'conflict' });
      continue;
    }

    // Check if rebase actually changed HEAD
    const newHead = revParse('HEAD');
    const oldHead = revParse(`origin/${pr.branch}`);

    if (newHead === oldHead) {
      log(`  Already up to date.`);
      results.push({ number: pr.number, branch: pr.branch, status: 'up-to-date' });
      continue;
    }

    // Push the rebased branch
    const pushed = pushWithRetry(pr.branch);
    if (pushed) {
      log(`  Rebased and pushed successfully.`);
      results.push({ number: pr.number, branch: pr.branch, status: 'rebased' });
    } else {
      log(`  Push failed after retries.`);
      results.push({ number: pr.number, branch: pr.branch, status: 'push-failed' });
      failed++;
    }
  }

  // Return to original state
  gitSafe('checkout', '--detach', originalHead);

  return { results, failed };
}
