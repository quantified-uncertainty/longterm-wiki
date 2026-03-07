/**
 * PR Analysis — Automated rebase (no Claude needed).
 *
 * Tries a non-interactive `git rebase origin/main` on a PR branch.
 * If the rebase is clean, pushes. If conflicts arise, aborts and returns.
 * Callers can fall back to Claude for conflict resolution.
 */

import { gitSafe, pushWithRetry, configBotUser, revParse } from '../git.ts';
import type { AutoRebaseResult } from './types.ts';

/**
 * Try an automated rebase of the given branch onto origin/main.
 *
 * - Fetches latest, checks out the branch, attempts rebase
 * - On clean rebase: pushes with --force-with-lease
 * - On conflict: aborts rebase and returns failure
 *
 * The caller must save/restore the original branch if needed.
 */
export function tryAutomatedRebase(branch: string): AutoRebaseResult {
  try {
    configBotUser();
  } catch {
    return { success: false, status: 'checkout-failed' };
  }

  // Fetch latest
  const fetchMain = gitSafe('fetch', 'origin', 'main');
  if (!fetchMain.ok) {
    return { success: false, status: 'checkout-failed' };
  }

  const fetchBranch = gitSafe('fetch', 'origin', branch);
  if (!fetchBranch.ok) {
    return { success: false, status: 'checkout-failed' };
  }

  // Checkout the PR branch
  const checkout = gitSafe('checkout', '-B', branch, `origin/${branch}`);
  if (!checkout.ok) {
    return { success: false, status: 'checkout-failed' };
  }

  // Check if already up-to-date with main
  let mainSha: string;
  try {
    mainSha = revParse('origin/main');
  } catch {
    return { success: false, status: 'checkout-failed' };
  }
  const mergeBase = gitSafe('merge-base', branch, 'origin/main');
  if (mergeBase.ok && mergeBase.output.trim() === mainSha) {
    return { success: true, status: 'up-to-date' };
  }

  // Try rebase
  const rebase = gitSafe('rebase', 'origin/main');
  if (!rebase.ok) {
    // Conflict — abort and return
    gitSafe('rebase', '--abort');
    return { success: false, status: 'conflict' };
  }

  // Push
  const pushed = pushWithRetry(branch);
  if (!pushed) {
    return { success: false, status: 'push-failed' };
  }

  return { success: true, status: 'rebased' };
}
