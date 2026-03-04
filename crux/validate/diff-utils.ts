/**
 * Shared utilities for diffing against the main branch.
 * Used by validate-review-marker.ts and validate-checklist-required.ts.
 */

import { execSync } from 'child_process';
import { PROJECT_ROOT } from '../lib/content-types.ts';

/**
 * Parse the summary line from `git diff --stat`.
 * Example: " 12 files changed, 450 insertions(+), 120 deletions(-)"
 */
export function parseDiffStat(output: string): { files: number; lines: number } {
  const lines = output.trim().split('\n');
  const summaryLine = lines[lines.length - 1] || '';

  const filesMatch = summaryLine.match(/(\d+)\s+files?\s+changed/);
  const insertionsMatch = summaryLine.match(/(\d+)\s+insertions?\(\+\)/);
  const deletionsMatch = summaryLine.match(/(\d+)\s+deletions?\(-\)/);

  const files = filesMatch ? parseInt(filesMatch[1], 10) : 0;
  const insertions = insertionsMatch ? parseInt(insertionsMatch[1], 10) : 0;
  const deletions = deletionsMatch ? parseInt(deletionsMatch[1], 10) : 0;

  return { files, lines: insertions + deletions };
}

/**
 * Get the merge-base SHA between HEAD and main.
 * Returns empty string if it can't be determined.
 */
export function getMergeBase(): string {
  try {
    return execSync(
      'git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null',
      { cwd: PROJECT_ROOT, encoding: 'utf-8' }
    ).trim();
  } catch {
    return '';
  }
}

/**
 * Get diff stats (files changed, lines changed) against main branch.
 */
export function getDiffStats(): { files: number; lines: number } {
  try {
    const base = getMergeBase();
    if (!base) return { files: 0, lines: 0 };

    const stat = execSync(`git diff --stat ${base}...HEAD`, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
    });

    return parseDiffStat(stat);
  } catch {
    return { files: 0, lines: 0 };
  }
}
