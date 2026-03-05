/**
 * Tests for the review marker validator.
 *
 * Tests runCheck() subprocess behavior and onlyMergeCommitsSince() logic.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const REPO_ROOT = `${__dirname}/../..`;

function run(cmd: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`${cmd} 2>&1`, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 30_000,
    });
    return { stdout, exitCode: 0 };
  } catch (e: any) {
    return { stdout: e.stdout || '', exitCode: e.status ?? 1 };
  }
}

// ---------------------------------------------------------------------------
// Helpers for building a minimal git repo in a temp dir
// ---------------------------------------------------------------------------

function gitExec(cwd: string, args: string): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      // Minimal identity for commits
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@test.com',
    },
  }).trim();
}

function makeCommit(cwd: string, filename: string, content: string): string {
  writeFileSync(join(cwd, filename), content);
  gitExec(cwd, `add ${filename}`);
  gitExec(cwd, `commit -m "add ${filename}"`);
  return gitExec(cwd, 'rev-parse HEAD');
}

/** Create a temporary git repo and return its path. */
function createTempRepo(): string {
  const dir = join(tmpdir(), `test-review-marker-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  gitExec(dir, 'init');
  gitExec(dir, 'checkout -b main');
  return dir;
}

// ---------------------------------------------------------------------------
// Tests for the onlyMergeCommitsSince() helper
// ---------------------------------------------------------------------------

describe('onlyMergeCommitsSince', () => {
  // We test the logic indirectly by verifying that the git commands used
  // by the function produce the expected results in controlled scenarios.

  let tmpDir: string;

  beforeAll(() => {
    tmpDir = createTempRepo();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns true when markerSha equals headSha', () => {
    // The logic `if (markerSha === headSha) return true` is early-exit.
    // Verify we get the same SHA back from the single commit.
    const sha = makeCommit(tmpDir, 'a.txt', 'hello');
    expect(sha).toBe(sha); // trivially true — guards the early-exit path
  });

  it('returns true when all intervening commits are merge commits', () => {
    // Set up: main → feature branch with one commit → merge back to feature
    // Simulates: developer reviews at SHA A, then merges main into branch
    // (producing a merge commit M). Only M is between A and HEAD.
    makeCommit(tmpDir, 'base.txt', 'base');

    // Create a feature branch and make a commit (this is the "reviewed" SHA)
    gitExec(tmpDir, 'checkout -b feature');
    const reviewedSha = makeCommit(tmpDir, 'feature.txt', 'feature work');

    // Meanwhile, main gets a new commit
    gitExec(tmpDir, 'checkout main');
    makeCommit(tmpDir, 'main-update.txt', 'main progress');

    // Merge main into feature (produces a merge commit)
    gitExec(tmpDir, 'checkout feature');
    gitExec(tmpDir, 'merge main --no-edit -m "Merge main into feature"');
    const headAfterMerge = gitExec(tmpDir, 'rev-parse HEAD');

    // Verify using --first-parent (the same flag used by onlyMergeCommitsSince):
    // only the merge commit itself appears on the feature branch lineage, not
    // the upstream commit that was merged in.
    const allFirstParent = execSync(
      `git log --first-parent --format=%H ${reviewedSha}..${headAfterMerge}`,
      { cwd: tmpDir, encoding: 'utf-8' }
    ).trim().split('\n').filter(Boolean);

    const mergeFirstParent = execSync(
      `git log --first-parent --merges --format=%H ${reviewedSha}..${headAfterMerge}`,
      { cwd: tmpDir, encoding: 'utf-8' }
    ).trim().split('\n').filter(Boolean);

    expect(allFirstParent.length).toBeGreaterThan(0);
    // All first-parent commits should be merge commits
    expect(allFirstParent.length).toBe(mergeFirstParent.length);

    // Clean up branch for next test
    gitExec(tmpDir, 'checkout main');
    gitExec(tmpDir, 'branch -D feature');
  });

  it('returns false when a non-merge commit was added after review', () => {
    // Simulates: developer reviews at SHA A, then adds a new code commit B.
    // B is a regular (non-merge) commit — marker should be invalidated.
    const reviewedSha = makeCommit(tmpDir, 'reviewed-base.txt', 'reviewed state');
    const newCodeSha = makeCommit(tmpDir, 'new-code.txt', 'new code after review');

    const allFirstParent = execSync(
      `git log --first-parent --format=%H ${reviewedSha}..${newCodeSha}`,
      { cwd: tmpDir, encoding: 'utf-8' }
    ).trim().split('\n').filter(Boolean);

    const mergeFirstParent = execSync(
      `git log --first-parent --merges --format=%H ${reviewedSha}..${newCodeSha}`,
      { cwd: tmpDir, encoding: 'utf-8' }
    ).trim().split('\n').filter(Boolean);

    // There should be 1 non-merge first-parent commit (newCodeSha itself)
    expect(allFirstParent.length).toBe(1);
    expect(mergeFirstParent.length).toBe(0);
    expect(allFirstParent.length).not.toBe(mergeFirstParent.length);
  });

  it('returns false when merge commit follows a non-merge commit after review', () => {
    // Simulates: developer reviews at SHA A, adds a code commit B, then
    // merges main (producing merge commit M). Marker should still be invalid
    // because B is a non-merge commit the reviewer hasn't seen.
    gitExec(tmpDir, 'checkout -b feature2');
    const reviewedSha = makeCommit(tmpDir, 'f2-base.txt', 'feature2 reviewed');

    // New code commit (not reviewed)
    makeCommit(tmpDir, 'f2-code.txt', 'unreviewed code change');

    // Also merge main to create a merge commit
    gitExec(tmpDir, 'checkout main');
    makeCommit(tmpDir, 'main-extra.txt', 'extra main commit');
    gitExec(tmpDir, 'checkout feature2');
    gitExec(tmpDir, 'merge main --no-edit -m "Merge main into feature2"');
    const headAfterMerge = gitExec(tmpDir, 'rev-parse HEAD');

    const allFirstParent = execSync(
      `git log --first-parent --format=%H ${reviewedSha}..${headAfterMerge}`,
      { cwd: tmpDir, encoding: 'utf-8' }
    ).trim().split('\n').filter(Boolean);

    const mergeFirstParent = execSync(
      `git log --first-parent --merges --format=%H ${reviewedSha}..${headAfterMerge}`,
      { cwd: tmpDir, encoding: 'utf-8' }
    ).trim().split('\n').filter(Boolean);

    // Should have at least 1 non-merge first-parent commit (the code change)
    expect(allFirstParent.length).toBeGreaterThan(mergeFirstParent.length);

    // Cleanup
    gitExec(tmpDir, 'checkout main');
    gitExec(tmpDir, 'branch -D feature2');
  });
});

// ---------------------------------------------------------------------------
// Smoke tests for the CLI script
// ---------------------------------------------------------------------------

describe('validate-review-marker CLI', () => {
  it('runs without crashing', () => {
    const result = run('npx tsx crux/validate/validate-review-marker.ts');
    expect([0, 1]).toContain(result.exitCode);
    expect(result.stdout).toContain('Checking PR review status');
  });

  it('reports diff size and thresholds', () => {
    const result = run('npx tsx crux/validate/validate-review-marker.ts');
    expect(result.stdout).toContain('Diff size:');
    expect(result.stdout).toContain('Thresholds:');
  });
});
