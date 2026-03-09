/**
 * PR Analysis — Automated rebase (no Claude needed).
 *
 * Tries a non-interactive `git rebase origin/main` on a PR branch.
 * If the rebase is clean, pushes. If conflicts arise, aborts and returns.
 * Callers can fall back to Claude for conflict resolution.
 *
 * Accepts an optional `cwd` parameter to run in a git worktree.
 */

import { gitSafe, gitSafeIn, pushWithRetry, pushWithRetryIn, configBotUser, revParse } from '../git.ts';
import { gitIn } from '../git.ts';
import type { AutoRebaseResult } from './types.ts';

/**
 * Try an automated rebase of the given branch onto origin/main.
 *
 * - Fetches latest, checks out the branch, attempts rebase
 * - On clean rebase: pushes with --force-with-lease
 * - On conflict: aborts rebase and returns failure
 *
 * When `cwd` is provided, all git operations run in that directory (worktree).
 * When omitted, operations run in the current working directory (caller must
 * save/restore the original branch).
 */
export function tryAutomatedRebase(branch: string, cwd?: string): AutoRebaseResult {
  // Create cwd-aware wrappers
  const safe = cwd
    ? (...args: string[]) => gitSafeIn(cwd, ...args)
    : (...args: string[]) => gitSafe(...args);
  const push = cwd
    ? (b: string) => pushWithRetryIn(cwd, b)
    : (b: string) => pushWithRetry(b);
  const parse = cwd
    ? (ref: string) => gitIn(cwd, 'rev-parse', ref)
    : (ref: string) => revParse(ref);

  try {
    configBotUser(cwd);
  } catch {
    return { success: false, status: 'checkout-failed' };
  }

  // Fetch latest
  const fetchMain = safe('fetch', 'origin', 'main');
  if (!fetchMain.ok) {
    return { success: false, status: 'checkout-failed' };
  }

  const fetchBranch = safe('fetch', 'origin', branch);
  if (!fetchBranch.ok) {
    return { success: false, status: 'checkout-failed' };
  }

  // Checkout the PR branch
  const checkout = safe('checkout', '-B', branch, `origin/${branch}`);
  if (!checkout.ok) {
    return { success: false, status: 'checkout-failed' };
  }

  // Check if already up-to-date with main
  let mainSha: string;
  try {
    mainSha = parse('origin/main');
  } catch {
    return { success: false, status: 'checkout-failed' };
  }
  const mergeBase = safe('merge-base', branch, 'origin/main');
  if (mergeBase.ok && mergeBase.output.trim() === mainSha) {
    return { success: true, status: 'up-to-date' };
  }

  // Try rebase
  const rebase = safe('rebase', 'origin/main');
  if (!rebase.ok) {
    // Conflict — abort and return
    safe('rebase', '--abort');
    return { success: false, status: 'conflict' };
  }

  // Push
  const pushed = push(branch);
  if (!pushed) {
    return { success: false, status: 'push-failed' };
  }

  return { success: true, status: 'rebased' };
}
