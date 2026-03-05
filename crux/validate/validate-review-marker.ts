#!/usr/bin/env node

/**
 * Validate that large PRs have been reviewed via /review-pr.
 *
 * Checks:
 *   1. Count files changed and lines changed (insertions + deletions) vs main
 *   2. If the diff exceeds thresholds (>5 files OR >300 lines):
 *      - Check if .claude/review-done exists
 *      - Verify it contains a commit SHA that matches the current HEAD
 *      - Verify it contains a diff hash matching the current diff content
 *   3. Fail (exit 1) if no valid marker is found — this blocks the gate
 *
 * The marker file format is:
 *   reviewed <commit-sha> <ISO-timestamp> <diff-hash>
 *
 * The diff-hash is the first 12 hex chars of SHA-256(git diff main...HEAD).
 * It proves the marker was generated for this specific set of changes.
 *
 * This check is blocking for large PRs. Small PRs (within thresholds) pass
 * automatically. See the gate step in validate-gate.ts.
 *
 * Usage: npx tsx crux/validate/validate-review-marker.ts
 */

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { join } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';
import { getDiffStats, getMergeBase } from './diff-utils.ts';

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
 * Compute a SHA-256 hash of the diff content (first 12 hex chars).
 * This "proof-of-work" ties the marker to the specific diff at review time,
 * preventing trivial forgery (writing the marker without running /review-pr).
 *
 * Uses raw Buffer (not UTF-8 string) to match the shell `shasum` behavior,
 * ensuring the hash is identical whether computed here or via the shell
 * command in review-pr.md.
 */
export function computeDiffHash(): string {
  try {
    const base = getMergeBase();
    if (!base) return '';

    // No `encoding` option → returns Buffer with raw bytes, matching
    // what `shasum -a 256` receives when piped from `git diff`.
    const diffBuffer: Buffer = execSync(`git diff ${base}...HEAD`, {
      cwd: PROJECT_ROOT,
      maxBuffer: 50 * 1024 * 1024, // 50MB for large diffs
    });

    return createHash('sha256').update(diffBuffer).digest('hex').slice(0, 12);
  } catch {
    return '';
  }
}

/**
 * Read and validate the review marker file.
 * Format: "reviewed <sha> <timestamp> <diff-hash>"
 * Legacy format (without diff-hash): "reviewed <sha> <timestamp>"
 */
function readMarker(): { found: boolean; sha: string; timestamp: string; diffHash: string } {
  try {
    const content = readFileSync(MARKER_FILE, 'utf-8').trim();
    const parts = content.split(/\s+/);
    if (parts[0] === 'reviewed' && parts[1]) {
      return { found: true, sha: parts[1], timestamp: parts[2] || '', diffHash: parts[3] || '' };
    }
    return { found: true, sha: '', timestamp: '', diffHash: '' };
  } catch {
    return { found: false, sha: '', timestamp: '', diffHash: '' };
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

  // Verify diff hash (proof-of-work) — the marker must include a hash of the
  // actual diff content, proving it was generated by /review-pr for this exact
  // set of changes, not copy-pasted or manually written.
  if (!marker.diffHash) {
    const reason = 'Review marker missing diff hash — was it created manually? Run /review-pr to generate a valid marker.';
    console.log(`\n${c.yellow}WARNING: ${reason}${c.reset}`);
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

  const currentDiffHash = computeDiffHash();
  if (!currentDiffHash) {
    // Fail-closed: if we can't compute the diff hash, we can't verify
    // the marker's proof-of-work. Don't silently pass.
    const reason = 'Could not compute diff hash to verify review marker — run /review-pr again';
    console.log(`\n${c.yellow}WARNING: ${reason}${c.reset}`);
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

  if (marker.diffHash !== currentDiffHash) {
    const reason = `Review marker diff hash (${marker.diffHash}) does not match current diff (${currentDiffHash}) — diff changed since review`;
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

  console.log(`\n${c.green}Review marker valid — reviewed at ${marker.timestamp || 'unknown time'} (SHA: ${marker.sha.slice(0, 8)}, diff: ${marker.diffHash})${c.reset}`);
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
