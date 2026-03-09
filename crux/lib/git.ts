/**
 * Shared Git Utilities
 *
 * Safe git operations using execFileSync (no shell — prevents command injection).
 * Used by crux pr rebase-all, crux pr resolve-conflicts, and auto-update CI orchestration.
 */

import { execFileSync } from 'child_process';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';

// ── Types ────────────────────────────────────────────────────────────────────

export interface GitResult {
  ok: boolean;
  output: string;
  stderr: string;
  code: number;
}

// ── Core git helpers ─────────────────────────────────────────────────────────

/**
 * Run a git command. Throws on non-zero exit.
 * Uses execFileSync (no shell) to prevent command injection.
 */
export function git(...args: string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024, // 10 MB
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Run a git command with a custom cwd. Throws on non-zero exit.
 */
export function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Non-throwing git command. Returns { ok, output, stderr, code }.
 */
export function gitSafe(...args: string[]): GitResult {
  try {
    const output = execFileSync('git', args, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return { ok: true, output, stderr: '', code: 0 };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      ok: false,
      output: String(e.stdout ?? '').trim(),
      stderr: String(e.stderr ?? '').trim(),
      code: e.status ?? 1,
    };
  }
}

/**
 * Non-throwing git command with custom cwd. Returns { ok, output, stderr, code }.
 */
export function gitSafeIn(cwd: string, ...args: string[]): GitResult {
  try {
    const output = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return { ok: true, output, stderr: '', code: 0 };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      ok: false,
      output: String(e.stdout ?? '').trim(),
      stderr: String(e.stderr ?? '').trim(),
      code: e.status ?? 1,
    };
  }
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate a branch name is safe for git operations.
 * Allows alphanumeric, dots, slashes, hyphens, and underscores.
 */
export function isValidBranchName(name: string): boolean {
  if (!name || name.length > 255) return false;
  return /^[a-zA-Z0-9._\/-]+$/.test(name);
}

// ── Bot identity ─────────────────────────────────────────────────────────────

/**
 * Configure git user for automated commits (bot identity).
 */
export function configBotUser(cwd?: string): void {
  const run = cwd ? (...args: string[]) => gitIn(cwd, ...args) : git;
  run('config', 'user.name', 'github-actions[bot]');
  run('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
}

// ── Common operations ────────────────────────────────────────────────────────

/**
 * Get the current branch name.
 */
export function currentBranch(): string {
  return git('rev-parse', '--abbrev-ref', 'HEAD');
}

/**
 * Get the SHA of a ref.
 */
export function revParse(ref: string): string {
  return git('rev-parse', ref);
}

/**
 * Get the unix epoch timestamp of a commit.
 */
export function commitEpoch(ref: string): number {
  const ts = git('log', '-1', '--format=%ct', ref);
  return parseInt(ts, 10);
}

/**
 * Get the commit message subject of a ref.
 */
export function commitSubject(ref: string): string {
  return git('log', '-1', '--format=%s', ref);
}

/**
 * Push with --force-with-lease and retry logic.
 * Returns true on success, false on failure after all attempts.
 */
export function pushWithRetry(
  branch: string,
  maxAttempts = 3,
  baseDelayMs = 2000,
): boolean {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = gitSafe('push', '--force-with-lease', 'origin', branch);
    if (result.ok) return true;

    console.warn(
      `Push attempt ${attempt}/${maxAttempts} failed: ${result.stderr}`,
    );

    if (attempt < maxAttempts) {
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      // Synchronous sleep — acceptable for CI scripts
      execFileSync('sleep', [String(delayMs / 1000)]);
      // Re-fetch in case remote moved
      gitSafe('fetch', 'origin', branch);
    }
  }
  return false;
}

/**
 * Push with --force-with-lease and retry logic, in a specific directory.
 */
export function pushWithRetryIn(
  cwd: string,
  branch: string,
  maxAttempts = 3,
  baseDelayMs = 2000,
): boolean {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = gitSafeIn(cwd, 'push', '--force-with-lease', 'origin', branch);
    if (result.ok) return true;

    console.warn(
      `Push attempt ${attempt}/${maxAttempts} failed: ${result.stderr}`,
    );

    if (attempt < maxAttempts) {
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      execFileSync('sleep', [String(delayMs / 1000)]);
      gitSafeIn(cwd, 'fetch', 'origin', branch);
    }
  }
  return false;
}

// ── Worktree management ─────────────────────────────────────────────────────

/**
 * Create a git worktree for the given branch.
 * Returns the worktree path. Throws on failure.
 */
export function createWorktree(
  basePath: string,
  name: string,
  branch: string,
  opts?: { detach?: boolean },
): string {
  const wtPath = join(basePath, '.claude', 'worktrees', name);
  mkdirSync(join(basePath, '.claude', 'worktrees'), { recursive: true });

  // Remove stale worktree at this path if it exists
  gitSafe('worktree', 'remove', '--force', wtPath);

  if (opts?.detach) {
    git('worktree', 'add', '--detach', wtPath, branch);
  } else {
    gitSafe('fetch', 'origin', branch);
    git('worktree', 'add', '-B', branch, wtPath, `origin/${branch}`);
  }

  return wtPath;
}

/**
 * Remove a git worktree. Best-effort — logs warning on failure.
 * Cleans up any in-progress rebase/merge state first.
 */
export function removeWorktree(wtPath: string): void {
  gitSafeIn(wtPath, 'rebase', '--abort');
  gitSafeIn(wtPath, 'merge', '--abort');

  const result = gitSafe('worktree', 'remove', '--force', wtPath);
  if (!result.ok) {
    console.warn(`Warning: could not remove worktree ${wtPath}: ${result.stderr}`);
    try { rmSync(wtPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    gitSafe('worktree', 'prune');
  }
}

/**
 * Get list of files changed between two refs.
 */
export function changedFiles(fromRef: string, toRef: string): string[] {
  const output = git('diff', '--name-only', fromRef, toRef);
  return output ? output.split('\n').filter(Boolean) : [];
}

/**
 * Check if working directory has uncommitted changes.
 */
export function hasChanges(): boolean {
  const staged = gitSafe('diff', '--staged', '--quiet');
  const unstaged = gitSafe('diff', '--quiet');
  return !staged.ok || !unstaged.ok;
}
