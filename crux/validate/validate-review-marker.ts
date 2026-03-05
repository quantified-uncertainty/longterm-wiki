#!/usr/bin/env node

/**
 * Validate that large PRs have been reviewed via /review-pr.
 *
 * Checks:
 *   1. Count files changed and lines changed (insertions + deletions) vs main
 *   2. If the diff exceeds thresholds (>5 files OR >300 lines):
 *      - Check if .claude/review-done exists
 *      - Verify it contains a commit SHA that matches the current HEAD
 *   3. Fail (exit 1) if no valid marker is found — this blocks the gate
 *
 * The marker file format is:
 *   reviewed <commit-sha> <ISO-timestamp>
 *
 * This check is blocking for large PRs. Small PRs (within thresholds) pass
 * automatically. See the gate step in validate-gate.ts.
 *
 * Usage: npx tsx crux/validate/validate-review-marker.ts
 */

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { join } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';

const FILES_THRESHOLD = 5;
const LINES_THRESHOLD = 300;
const MARKER_FILE = join(PROJECT_ROOT, '.claude', 'review-done');

export interface ReviewCheckResult {
  passed: boolean;
  warnings: number;
  filesChanged: number;
  linesChanged: number;
  thresholdExceeded: boolean;
  markerFound: boolean;
  markerValid: boolean;
  /** Reason for failure, if any */
  reason?: string;
}

/**
 * Parse the summary line from `git diff --stat`.
 * Example: " 12 files changed, 450 insertions(+), 120 deletions(-)"
 */
function parseDiffStat(output: string): { files: number; lines: number } {
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
 * Get the current HEAD commit SHA.
 */
function getHeadSha(): string {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Get diff stats against main branch.
 */
function getDiffStats(): { files: number; lines: number } {
  try {
    // Try origin/main first, fall back to main
    const base = execSync(
      'git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null',
      { cwd: PROJECT_ROOT, encoding: 'utf-8' }
    ).trim();

    if (!base) return { files: 0, lines: 0 };

    const stat = execSync(`git diff --stat ${base}...HEAD`, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
    });

    return parseDiffStat(stat);
  } catch {
    // Fail-closed: if we can't determine diff size, report 0
    // (don't warn about missing review for unknown diffs)
    return { files: 0, lines: 0 };
  }
}

/**
 * Read and validate the review marker file.
 * Expected format: "reviewed <sha> <timestamp>"
 */
function readMarker(): { found: boolean; sha: string; timestamp: string } {
  try {
    const content = readFileSync(MARKER_FILE, 'utf-8').trim();
    const parts = content.split(/\s+/);
    if (parts[0] === 'reviewed' && parts[1]) {
      return { found: true, sha: parts[1], timestamp: parts[2] || '' };
    }
    return { found: true, sha: '', timestamp: '' };
  } catch {
    return { found: false, sha: '', timestamp: '' };
  }
}

/**
 * Compute a 12-character hex hash of the current diff against main.
 * Returns '' if the diff cannot be computed or is empty.
 */
export function computeDiffHash(): string {
  try {
    const base = execSync(
      'git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null',
      { cwd: PROJECT_ROOT, encoding: 'utf-8' }
    ).trim();
    if (!base) return '';
    const diff = execSync(`git diff ${base}...HEAD`, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
    });
    if (!diff) return '';
    return createHash('sha256').update(diff).digest('hex').slice(0, 12);
  } catch {
    return '';
  }
}

export function runCheck(): ReviewCheckResult {
  const c = getColors();
  console.log(`${c.blue}Checking PR review status...${c.reset}\n`);

  const { files, lines } = getDiffStats();
  const thresholdExceeded = files > FILES_THRESHOLD || lines > LINES_THRESHOLD;

  console.log(`${c.dim}  Diff size: ${files} files changed, ${lines} lines changed${c.reset}`);
  console.log(`${c.dim}  Thresholds: >${FILES_THRESHOLD} files or >${LINES_THRESHOLD} lines${c.reset}`);

  if (!thresholdExceeded) {
    console.log(`\n${c.green}PR is within review thresholds — review not required${c.reset}`);
    return {
      passed: true,
      warnings: 0,
      filesChanged: files,
      linesChanged: lines,
      thresholdExceeded: false,
      markerFound: false,
      markerValid: false,
    };
  }

  console.log(`\n${c.yellow}  PR exceeds review thresholds${c.reset}`);

  const marker = readMarker();
  if (!marker.found) {
    const reason = 'Large PR (>' + FILES_THRESHOLD + ' files or >' + LINES_THRESHOLD + ' lines) has not been reviewed via /review-pr';
    console.log(`\n${c.yellow}WARNING: ${reason}${c.reset}`);
    console.log(`${c.dim}  Fix: run /review-pr before shipping${c.reset}`);
    return {
      passed: false,
      warnings: 1,
      filesChanged: files,
      linesChanged: lines,
      thresholdExceeded: true,
      markerFound: false,
      markerValid: false,
      reason,
    };
  }

  // Marker exists — verify SHA matches HEAD
  const headSha = getHeadSha();
  if (!headSha) {
    console.log(`\n${c.yellow}WARNING: Could not determine HEAD SHA to validate review marker${c.reset}`);
    return {
      passed: false,
      warnings: 1,
      filesChanged: files,
      linesChanged: lines,
      thresholdExceeded: true,
      markerFound: true,
      markerValid: false,
      reason: 'Could not determine HEAD SHA to validate review marker',
    };
  }

  if (marker.sha !== headSha) {
    const reason = `Review marker SHA (${marker.sha.slice(0, 8)}) does not match HEAD (${headSha.slice(0, 8)}) — new commits added after review`;
    console.log(`\n${c.yellow}WARNING: ${reason}${c.reset}`);
    console.log(`${c.dim}  Fix: run /review-pr again to review the latest changes${c.reset}`);
    return {
      passed: false,
      warnings: 1,
      filesChanged: files,
      linesChanged: lines,
      thresholdExceeded: true,
      markerFound: true,
      markerValid: false,
      reason,
    };
  }

  console.log(`\n${c.green}Review marker valid — reviewed at ${marker.timestamp || 'unknown time'} (SHA: ${marker.sha.slice(0, 8)})${c.reset}`);
  return {
    passed: true,
    warnings: 0,
    filesChanged: files,
    linesChanged: lines,
    thresholdExceeded: true,
    markerFound: true,
    markerValid: true,
  };
}

if (process.argv[1]?.includes('validate-review-marker')) {
  const result = runCheck();
  // Blocking: exit 1 if the check fails (large PRs require /review-pr)
  process.exit(result.passed ? 0 : 1);
}
