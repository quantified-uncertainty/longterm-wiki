/**
 * QA Sweep Result Persistence
 *
 * Saves sweep results as JSON files in .claude/sweep-results/ so future runs
 * can diff against them and track regressions.
 *
 * Directory layout:
 *   .claude/sweep-results/
 *     2026-03-19T14-30-00.json   (timestamped result files)
 *     2026-03-19T16-45-00.json
 *     latest.json                (copy of most recent result)
 *
 * "latest.json" is a real file (not a symlink) for cross-platform portability.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';

// ---------------------------------------------------------------------------
// Types (re-exported so the sweep script can import them)
// ---------------------------------------------------------------------------

export interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warn' | 'skip';
  message: string;
  details?: string[];
  tier?: 'basic' | 'data-integrity' | 'slow';
}

export interface RecentChange {
  type: 'pr' | 'commit';
  id: string;
  title: string;
  date: string;
  files?: number;
}

export interface SweepReport {
  timestamp: string;
  recentChanges: RecentChange[];
  changedFiles: string[];
  checks: CheckResult[];
}

// A persisted result extends the report with a wall-clock save time so we can
// order results even if the same logical date is run twice.
export interface PersistedSweepResult extends SweepReport {
  savedAt: string; // ISO 8601 wall-clock time at which the file was written
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const RESULTS_DIR = join(PROJECT_ROOT, '.claude/sweep-results');
const LATEST_FILE = join(RESULTS_DIR, 'latest.json');

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

function ensureDir(): void {
  if (!existsSync(RESULTS_DIR)) {
    mkdirSync(RESULTS_DIR, { recursive: true });
  }
}

/**
 * Return all persisted result file paths (excluding latest.json), sorted from
 * oldest to newest.
 */
export function listResultFiles(): string[] {
  if (!existsSync(RESULTS_DIR)) return [];
  return readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'latest.json')
    .sort() // ISO timestamps sort lexicographically = chronologically
    .map((f) => join(RESULTS_DIR, f));
}

/**
 * Load a persisted result from a file path.  Returns null if the file cannot
 * be read or does not look like a valid result.
 */
export function loadResult(filePath: string): PersistedSweepResult | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isPersistedResult(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isPersistedResult(value: unknown): value is PersistedSweepResult {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.timestamp === 'string' &&
    typeof v.savedAt === 'string' &&
    Array.isArray(v.checks) &&
    Array.isArray(v.recentChanges) &&
    Array.isArray(v.changedFiles)
  );
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/**
 * Save a sweep report to the results directory.
 * Returns the path of the file that was written.
 */
export function saveResult(report: SweepReport): string {
  ensureDir();

  const savedAt = new Date().toISOString();
  // Derive a filesystem-safe timestamp from savedAt: replace colons with dashes
  const fileStem = savedAt.replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
  const fileName = `${fileStem}.json`;
  const filePath = join(RESULTS_DIR, fileName);

  const persisted: PersistedSweepResult = { ...report, savedAt };
  const json = JSON.stringify(persisted, null, 2);

  writeFileSync(filePath, json, 'utf-8');
  // Update latest.json (plain copy, not symlink — works on all platforms)
  writeFileSync(LATEST_FILE, json, 'utf-8');

  return filePath;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface CheckDiff {
  name: string;
  /**
   * How the status changed.  A check not present in one run is treated as
   * 'skip' so callers can detect checks added or removed between runs.
   */
  previousStatus: CheckStatus | 'missing';
  currentStatus: CheckStatus | 'missing';
  previousMessage: string;
  currentMessage: string;
  /** True if this check went from any non-pass to pass */
  resolved: boolean;
  /** True if this check is now failing or warning but was not before */
  regressed: boolean;
  /** True if this check failed / warned in both runs */
  recurring: boolean;
  /** True if this check appears only in the current run (newly added check) */
  newCheck: boolean;
  /** True if this check appears only in the previous run (removed check) */
  removedCheck: boolean;
}

export interface SweepDiff {
  previous: {
    timestamp: string;
    savedAt: string;
    failCount: number;
    warnCount: number;
    passCount: number;
  };
  current: {
    timestamp: string;
    savedAt: string;
    failCount: number;
    warnCount: number;
    passCount: number;
  };
  /** Check-by-check diffs, one entry per unique check name across both runs */
  checks: CheckDiff[];
  /** Checks where status got worse (fail or warn when it wasn't before) */
  regressions: CheckDiff[];
  /** Checks where status got better (now passing when it wasn't before) */
  resolved: CheckDiff[];
  /** Checks that were failing/warning in both runs */
  recurring: CheckDiff[];
  /** Checks that appear for the first time in the current run */
  newChecks: CheckDiff[];
  /** Checks present in previous but absent in current */
  removedChecks: CheckDiff[];
}

/** Score a status for regression detection: higher = worse */
function statusSeverity(s: CheckStatus | 'missing'): number {
  const order: Record<string, number> = { pass: 0, skip: 1, warn: 2, fail: 3, missing: -1 };
  return order[s] ?? -1;
}

function isProblematic(s: CheckStatus | 'missing'): boolean {
  return s === 'fail' || s === 'warn';
}

/**
 * Produce a structured diff between two sweep results.
 */
export function diffResults(previous: PersistedSweepResult, current: PersistedSweepResult): SweepDiff {
  const prevByName = new Map<string, CheckResult>(previous.checks.map((c) => [c.name, c]));
  const currByName = new Map<string, CheckResult>(current.checks.map((c) => [c.name, c]));

  const allNames = new Set([...prevByName.keys(), ...currByName.keys()]);

  const checks: CheckDiff[] = [];

  for (const name of allNames) {
    const prev = prevByName.get(name);
    const curr = currByName.get(name);

    const previousStatus: CheckStatus | 'missing' = prev ? prev.status : 'missing';
    const currentStatus: CheckStatus | 'missing' = curr ? curr.status : 'missing';

    const prevSeverity = statusSeverity(previousStatus);
    const currSeverity = statusSeverity(currentStatus);

    // A regression is any increase in severity (warn→fail counts as well as pass→fail).
    const regressed =
      curr !== undefined &&
      prev !== undefined &&
      currSeverity > prevSeverity &&
      isProblematic(currentStatus);
    // Resolved means severity went down and the check is no longer problematic.
    const resolved =
      curr !== undefined &&
      prev !== undefined &&
      !isProblematic(currentStatus) &&
      isProblematic(previousStatus);
    // Recurring means problematic in both runs AND severity did not increase.
    const recurring =
      curr !== undefined &&
      prev !== undefined &&
      isProblematic(currentStatus) &&
      isProblematic(previousStatus) &&
      currSeverity <= prevSeverity;
    const newCheck = prev === undefined && curr !== undefined;
    const removedCheck = curr === undefined && prev !== undefined;

    checks.push({
      name,
      previousStatus,
      currentStatus,
      previousMessage: prev?.message ?? '',
      currentMessage: curr?.message ?? '',
      resolved,
      regressed,
      recurring,
      newCheck,
      removedCheck,
    });
  }

  const regressions = checks.filter((c) => c.regressed);
  const resolvedList = checks.filter((c) => c.resolved);
  const recurringList = checks.filter((c) => c.recurring);
  const newChecks = checks.filter((c) => c.newCheck);
  const removedChecks = checks.filter((c) => c.removedCheck);

  const countStatus = (result: PersistedSweepResult, status: CheckStatus): number =>
    result.checks.filter((c) => c.status === status).length;

  return {
    previous: {
      timestamp: previous.timestamp,
      savedAt: previous.savedAt,
      failCount: countStatus(previous, 'fail'),
      warnCount: countStatus(previous, 'warn'),
      passCount: countStatus(previous, 'pass'),
    },
    current: {
      timestamp: current.timestamp,
      savedAt: current.savedAt,
      failCount: countStatus(current, 'fail'),
      warnCount: countStatus(current, 'warn'),
      passCount: countStatus(current, 'pass'),
    },
    checks,
    regressions,
    resolved: resolvedList,
    recurring: recurringList,
    newChecks,
    removedChecks,
  };
}

// ---------------------------------------------------------------------------
// Text rendering
// ---------------------------------------------------------------------------

/**
 * Format a SweepDiff as a human-readable text block.
 */
export function formatDiff(diff: SweepDiff, useColor = true): string {
  const c = useColor
    ? {
        red: '\x1b[31m',
        green: '\x1b[32m',
        yellow: '\x1b[33m',
        bold: '\x1b[1m',
        dim: '\x1b[2m',
        reset: '\x1b[0m',
      }
    : { red: '', green: '', yellow: '', bold: '', dim: '', reset: '' };

  const lines: string[] = [];

  // Header
  lines.push(`${c.bold}QA Sweep Diff${c.reset}`);
  lines.push(
    `  Previous: ${diff.previous.timestamp} (saved ${diff.previous.savedAt.slice(0, 19)}Z)`,
  );
  lines.push(
    `  Current:  ${diff.current.timestamp} (saved ${diff.current.savedAt.slice(0, 19)}Z)`,
  );
  lines.push('');

  // Trend summary
  const failDelta = diff.current.failCount - diff.previous.failCount;
  const warnDelta = diff.current.warnCount - diff.previous.warnCount;
  const failStr =
    failDelta === 0
      ? `${diff.current.failCount} (unchanged)`
      : failDelta > 0
        ? `${c.red}${diff.current.failCount} (+${failDelta})${c.reset}`
        : `${c.green}${diff.current.failCount} (${failDelta})${c.reset}`;
  const warnStr =
    warnDelta === 0
      ? `${diff.current.warnCount} (unchanged)`
      : warnDelta > 0
        ? `${c.yellow}${diff.current.warnCount} (+${warnDelta})${c.reset}`
        : `${c.green}${diff.current.warnCount} (${warnDelta})${c.reset}`;

  lines.push(`${c.bold}Trends${c.reset}`);
  lines.push(`  Failures: ${failStr}`);
  lines.push(`  Warnings: ${warnStr}`);
  lines.push('');

  // Regressions (most urgent)
  if (diff.regressions.length > 0) {
    lines.push(`${c.red}${c.bold}NEW REGRESSIONS (${diff.regressions.length})${c.reset}`);
    for (const ch of diff.regressions) {
      lines.push(`  ${c.red}✗${c.reset} ${ch.name}`);
      lines.push(`    ${c.dim}was:${c.reset} ${ch.previousMessage}`);
      lines.push(`    ${c.dim}now:${c.reset} ${ch.currentMessage}`);
    }
    lines.push('');
  }

  // Resolved issues
  if (diff.resolved.length > 0) {
    lines.push(`${c.green}${c.bold}RESOLVED (${diff.resolved.length})${c.reset}`);
    for (const ch of diff.resolved) {
      lines.push(`  ${c.green}✓${c.reset} ${ch.name}`);
      lines.push(`    ${c.dim}was:${c.reset} ${ch.previousMessage}`);
      lines.push(`    ${c.dim}now:${c.reset} ${ch.currentMessage}`);
    }
    lines.push('');
  }

  // Recurring issues
  if (diff.recurring.length > 0) {
    lines.push(`${c.yellow}${c.bold}RECURRING ISSUES (${diff.recurring.length})${c.reset}`);
    for (const ch of diff.recurring) {
      const statusLabel =
        ch.currentStatus === ch.previousStatus
          ? ch.currentStatus
          : `${ch.previousStatus} → ${ch.currentStatus}`;
      lines.push(`  ${c.yellow}⚠${c.reset} ${ch.name} [${statusLabel}]`);
      lines.push(`    ${c.dim}${ch.currentMessage}${c.reset}`);
    }
    lines.push('');
  }

  // New checks (first appearance — neutral information)
  if (diff.newChecks.length > 0) {
    lines.push(`${c.bold}NEW CHECKS (${diff.newChecks.length})${c.reset}`);
    for (const ch of diff.newChecks) {
      lines.push(
        `  ${ch.currentStatus === 'pass' ? c.green + '✓' : ch.currentStatus === 'fail' ? c.red + '✗' : c.yellow + '⚠'}${c.reset} ${ch.name}: ${ch.currentMessage}`,
      );
    }
    lines.push('');
  }

  // Removed checks
  if (diff.removedChecks.length > 0) {
    lines.push(`${c.dim}${c.bold}REMOVED CHECKS (${diff.removedChecks.length})${c.reset}`);
    for (const ch of diff.removedChecks) {
      lines.push(`  ${c.dim}○ ${ch.name}${c.reset}`);
    }
    lines.push('');
  }

  // Footer
  if (
    diff.regressions.length === 0 &&
    diff.recurring.length === 0 &&
    diff.resolved.length === 0 &&
    diff.newChecks.length === 0 &&
    diff.removedChecks.length === 0
  ) {
    lines.push(`${c.green}No changes between runs.${c.reset}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Convenience: load the two most recent results
// ---------------------------------------------------------------------------

/**
 * Load the latest saved result.  Returns null if none exist.
 */
export function loadLatest(): PersistedSweepResult | null {
  if (!existsSync(LATEST_FILE)) return null;
  return loadResult(LATEST_FILE);
}

/**
 * Load the second-most-recent saved result (the one before latest).
 * Returns null if there are fewer than two saved results.
 */
export function loadPrevious(): PersistedSweepResult | null {
  const files = listResultFiles();
  if (files.length < 2) return null;
  // listResultFiles is sorted oldest-first; second-to-last is the previous run
  return loadResult(files[files.length - 2]);
}
