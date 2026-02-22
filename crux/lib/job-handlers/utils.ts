/**
 * Job Handler Utilities
 *
 * Shared helpers for git state management, file change tracking,
 * and other common operations used by job handlers.
 */

import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import type { FileChange } from './types.ts';

// ---------------------------------------------------------------------------
// Git State Management
// ---------------------------------------------------------------------------

/**
 * Capture the current git state (list of file hashes) for later comparison.
 * Returns a Map of relative path → short hash for tracked files.
 */
export function captureGitChanges(projectRoot: string): Map<string, string> {
  const hashes = new Map<string, string>();

  try {
    const output = execFileSync(
      'git', ['ls-files', '-s'],
      { cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();

    for (const line of output.split('\n')) {
      if (!line) continue;
      // Format: mode hash stage\tpath
      const parts = line.split('\t');
      if (parts.length >= 2) {
        const hash = parts[0].split(' ')[1];
        const path = parts[1];
        hashes.set(path, hash);
      }
    }
  } catch {
    // Ignore git errors
  }

  return hashes;
}

/**
 * Restore git working tree to HEAD state.
 * Removes untracked files in content/data directories and resets modifications.
 */
export function restoreGitState(projectRoot: string): void {
  try {
    // Reset tracked file modifications
    execFileSync('git', ['checkout', '--', '.'], {
      cwd: projectRoot,
      stdio: 'pipe',
    });

    // Remove untracked files in content/data directories only
    execFileSync('git', ['clean', '-fd', 'content/', 'data/'], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
  } catch {
    // Best effort
  }
}

/**
 * Collect all changed files (modified, added, deleted) relative to HEAD.
 * Returns FileChange entries with the current content of each file.
 */
export function collectChangedFiles(
  projectRoot: string,
  filter?: (path: string) => boolean,
): FileChange[] {
  const changes: FileChange[] = [];
  const changedFiles = new Set<string>();

  try {
    // Get modified/deleted files relative to HEAD
    const diffOutput = execFileSync(
      'git', ['diff', '--name-only', 'HEAD'],
      { cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();

    if (diffOutput) {
      for (const line of diffOutput.split('\n')) {
        if (line.trim()) changedFiles.add(line.trim());
      }
    }

    // Get untracked files
    const untrackedOutput = execFileSync(
      'git', ['ls-files', '--others', '--exclude-standard'],
      { cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();

    if (untrackedOutput) {
      for (const line of untrackedOutput.split('\n')) {
        if (line.trim()) changedFiles.add(line.trim());
      }
    }
  } catch {
    return changes;
  }

  for (const relativePath of changedFiles) {
    if (filter && !filter(relativePath)) continue;

    try {
      const fullPath = `${projectRoot}/${relativePath}`;
      const content = readFileSync(fullPath, 'utf-8');
      changes.push({ path: relativePath, content });
    } catch {
      changes.push({ path: relativePath, content: null });
    }
  }

  return changes;
}

/**
 * Check if a file path is wiki content (MDX pages, YAML data, etc.).
 */
export function isContentFile(path: string): boolean {
  if (path.startsWith('content/docs/')) return true;
  if (path.startsWith('data/')) return true;
  if (path.endsWith('.mdx') || path.endsWith('.yaml') || path.endsWith('.yml')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Branch & PR Helpers
// ---------------------------------------------------------------------------

/**
 * Create a new git branch from the current HEAD.
 * Returns true if the branch was created (or already exists).
 */
export function createBranch(projectRoot: string, branchName: string): boolean {
  try {
    execFileSync('git', ['checkout', '-b', branchName], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    return true;
  } catch {
    // Branch may already exist
    try {
      execFileSync('git', ['checkout', branchName], {
        cwd: projectRoot,
        stdio: 'pipe',
      });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Apply file changes to the working tree.
 * Writes each file's content (or deletes if content is null).
 * Validates that all paths resolve within the project root (prevents path traversal).
 */
export function applyFileChanges(
  projectRoot: string,
  changes: FileChange[],
): { applied: number; errors: string[]; appliedPaths: string[] } {
  const resolvedRoot = resolve(projectRoot);
  let applied = 0;
  const errors: string[] = [];
  const appliedPaths: string[] = [];

  for (const change of changes) {
    const fullPath = resolve(join(projectRoot, change.path));

    // Path traversal check: resolved path must start with the project root
    if (!fullPath.startsWith(resolvedRoot + '/') && fullPath !== resolvedRoot) {
      errors.push(`${change.path}: path traversal detected (resolves outside project root)`);
      continue;
    }

    // Only allow content-related paths
    if (!isContentFile(change.path)) {
      errors.push(`${change.path}: not a content file (skipped for safety)`);
      continue;
    }

    try {
      if (change.content === null) {
        // Delete
        unlinkSync(fullPath);
      } else {
        // Write (create directories if needed)
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, change.content, 'utf-8');
      }
      applied++;
      appliedPaths.push(change.path);
    } catch (err) {
      errors.push(`${change.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { applied, errors, appliedPaths };
}
