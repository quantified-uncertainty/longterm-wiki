/**
 * Scope Checker
 *
 * Enforces file scope constraints for AI-generated content changes.
 *
 * Primary use case: Tier 2 agent (conflict resolver) should ONLY modify
 * files that were identified as having merge conflicts. Any modification
 * to other files is a scope violation.
 *
 * This is a pure function module — no LLM calls, no side effects.
 * Takes lists of changed files and allowed files, returns violations.
 */

import path from 'path';
import type { ScopeCheckResult, ScopeViolation } from './types.ts';

// ---------------------------------------------------------------------------
// Path normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a file path for comparison.
 * Resolves relative paths, normalizes separators.
 */
function normalizePath(filePath: string, basePath?: string): string {
  if (basePath && !path.isAbsolute(filePath)) {
    return path.resolve(basePath, filePath);
  }
  return path.resolve(filePath);
}

// ---------------------------------------------------------------------------
// Scope rules
// ---------------------------------------------------------------------------

/**
 * Paths that are always allowed to be modified (meta-files, not content).
 * These are relative path fragments — any file containing these is allowed.
 */
const ALWAYS_ALLOWED_PATTERNS = [
  // Edit log — always safe to update
  'data/edit-log.yaml',
  // Auto-graded quality fields
  'data/entities/',
  // Session files
  '.claude/sessions/',
  // Temp files
  '.claude/temp/',
];

/**
 * Check if a file path matches any always-allowed pattern.
 */
function isAlwaysAllowed(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return ALWAYS_ALLOWED_PATTERNS.some(pattern =>
    normalized === pattern || normalized.startsWith(pattern)
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if all changed files are within the allowed scope.
 *
 * @param changedFiles - Files that were modified
 * @param allowedFiles - Files that are permitted to be modified
 * @param basePath - Optional base path for resolving relative paths
 * @returns Scope check result with violations
 */
export function checkScope(
  changedFiles: string[],
  allowedFiles: string[],
  basePath?: string,
): ScopeCheckResult {
  const normalizedAllowed = new Set(
    allowedFiles.map(f => normalizePath(f, basePath)),
  );

  const allowedChanges: string[] = [];
  const violations: ScopeViolation[] = [];

  for (const file of changedFiles) {
    const normalized = normalizePath(file, basePath);

    // Always-allowed meta-files
    if (isAlwaysAllowed(file)) {
      allowedChanges.push(file);
      continue;
    }

    // Check if in allowed list
    if (normalizedAllowed.has(normalized)) {
      allowedChanges.push(file);
    } else {
      violations.push({
        file,
        reason: `File "${file}" was not in the allowed scope for this operation`,
      });
    }
  }

  return {
    valid: violations.length === 0,
    allowedChanges,
    violations,
  };
}

/**
 * Check if a set of changed content files (MDX/YAML) are within scope.
 * Specialized version for content pipeline — auto-generates allowed set from
 * a list of page IDs and their corresponding file paths.
 *
 * @param changedFiles - Files that were actually modified
 * @param allowedPagePaths - MDX file paths for pages that are allowed to be changed
 */
export function checkContentScope(
  changedFiles: string[],
  allowedPagePaths: string[],
): ScopeCheckResult {
  return checkScope(changedFiles, allowedPagePaths);
}

/**
 * Filter a list of changed files to only return content files (MDX, YAML).
 * Useful for narrowing scope checks to just the content changes.
 */
export function filterContentFiles(files: string[]): string[] {
  return files.filter(f => /\.(mdx|yaml|yml)$/.test(f));
}

/**
 * Compute which MDX files were modified by comparing before/after directory state.
 * Returns relative paths from basePath.
 *
 * This is a utility for callers that need to detect file changes programmatically
 * rather than from git. For git-based workflows, use `git diff --name-only` instead.
 */
export function detectModifiedFiles(
  beforeFiles: Map<string, string>,  // path → content hash
  afterFiles: Map<string, string>,   // path → content hash
): { modified: string[]; added: string[]; deleted: string[] } {
  const modified: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];

  for (const [path, hash] of afterFiles) {
    if (!beforeFiles.has(path)) {
      added.push(path);
    } else if (beforeFiles.get(path) !== hash) {
      modified.push(path);
    }
  }

  for (const path of beforeFiles.keys()) {
    if (!afterFiles.has(path)) {
      deleted.push(path);
    }
  }

  return { modified, added, deleted };
}
