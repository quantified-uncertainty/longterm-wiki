/**
 * PR Patrol Log Reader
 *
 * Parses, filters, and aggregates JSONL log entries produced by the PR Patrol daemon.
 * Pure data functions — no terminal formatting or I/O side effects.
 */

import { existsSync, readFileSync } from 'fs';
import type { PrIssueType } from './index.ts';

// ── Log Entry Types ─────────────────────────────────────────────────────────

export interface PrResultEntry {
  type: 'pr_result';
  timestamp: string;
  pr_num: number;
  issues: PrIssueType[];
  outcome: 'fixed' | 'max-turns' | 'timeout' | 'error' | 'dry-run';
  elapsed_s: number;
  reason?: string;
}

export interface MergeResultEntry {
  type: 'merge_result';
  timestamp: string;
  pr_num: number;
  outcome: 'merged' | 'dry-run' | 'error';
  reason?: string;
}

export interface CycleSummaryEntry {
  type: 'cycle_summary';
  timestamp: string;
  cycle_number: number;
  prs_scanned: number;
  queue_size: number;
  pr_processed: number | null;
  pr_merged?: number | null;
  merge_candidates?: number;
  merge_eligible?: number;
  main_branch_fix?: boolean;
}

export interface MainBranchEntry {
  type: 'main_branch_result';
  timestamp: string;
  run_id: number;
  sha: string;
  outcome: 'fixed' | 'max-turns' | 'timeout' | 'error' | 'dry-run';
  elapsed_s: number;
  reason?: string;
}

export interface OverlapWarningEntry {
  type: 'overlap_warning';
  timestamp: string;
  pr_a: number;
  pr_b: number;
  shared_files: number;
}

export interface UndraftResultEntry {
  type: 'undraft_result';
  timestamp: string;
  pr_num: number;
  outcome: string;
  reason?: string;
}

export type LogEntry =
  | PrResultEntry
  | MergeResultEntry
  | CycleSummaryEntry
  | MainBranchEntry
  | OverlapWarningEntry
  | UndraftResultEntry;

// ── Type shorthands for filtering ───────────────────────────────────────────

const TYPE_MAP: Record<string, string> = {
  pr: 'pr_result',
  merge: 'merge_result',
  cycle: 'cycle_summary',
  main: 'main_branch_result',
  overlap: 'overlap_warning',
  undraft: 'undraft_result',
};

// ── Parsing ─────────────────────────────────────────────────────────────────

/** Parse all entries from a JSONL file. Skips malformed lines. */
export function readAllEntries(filePath: string): LogEntry[] {
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, 'utf-8').trim();
  if (!content) return [];

  const entries: LogEntry[] = [];
  for (const line of content.split('\n')) {
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object' && entry.type && entry.timestamp) {
        entries.push(entry as LogEntry);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

// ── Filtering ───────────────────────────────────────────────────────────────

/** Parse duration string ("1h", "6h", "24h", "7d", "30d") to milliseconds. */
export function parseDuration(since: string): number {
  const match = since.match(/^(\d+)([hd])$/);
  if (!match) throw new Error(`Invalid duration: "${since}". Use format like 1h, 24h, 7d, 30d.`);
  const value = parseInt(match[1], 10);
  const unit = match[2];
  return unit === 'h' ? value * 3600_000 : value * 86400_000;
}

/** Filter entries to those within a time window. */
export function filterByTime(entries: LogEntry[], since: string): LogEntry[] {
  const ms = parseDuration(since);
  const cutoff = Date.now() - ms;
  return entries.filter((e) => new Date(e.timestamp).getTime() >= cutoff);
}

/** Filter entries by type shorthand (e.g. "pr", "merge", "cycle"). */
export function filterByType(entries: LogEntry[], type: string): LogEntry[] {
  const fullType = TYPE_MAP[type] ?? type;
  return entries.filter((e) => e.type === fullType);
}

/** Filter to entries mentioning a specific PR number. */
export function filterByPr(entries: LogEntry[], prNum: number): LogEntry[] {
  return entries.filter((e) => {
    if ('pr_num' in e && e.pr_num === prNum) return true;
    if (e.type === 'cycle_summary' && (e.pr_processed === prNum || e.pr_merged === prNum))
      return true;
    if (e.type === 'overlap_warning' && (e.pr_a === prNum || e.pr_b === prNum)) return true;
    return false;
  });
}

/** Filter by outcome value. */
export function filterByOutcome(entries: LogEntry[], outcome: string): LogEntry[] {
  return entries.filter((e) => 'outcome' in e && e.outcome === outcome);
}

// ── Aggregation ─────────────────────────────────────────────────────────────

export interface PrTouchInfo {
  attempts: number;
  issues: string[];
  abandoned: boolean;
}

export interface AggregatedStats {
  cycles: {
    total: number;
    avgScanned: number;
    avgQueueSize: number;
  };
  fixes: {
    total: number;
    byOutcome: Record<string, number>;
  };
  merges: {
    total: number;
    byOutcome: Record<string, number>;
  };
  undrafts: {
    total: number;
  };
  issueTypes: Record<string, number>;
  prTouched: Map<number, PrTouchInfo>;
  performance: {
    avgFixTime: number;
    medianFixTime: number;
    maxFixTime: number;
    maxFixPr: number | null;
  };
  mainBranch: {
    total: number;
    byOutcome: Record<string, number>;
  };
  overlaps: number;
}

/** Compute aggregated stats over a set of log entries. */
export function computeStats(entries: LogEntry[]): AggregatedStats {
  const cycles = entries.filter((e): e is CycleSummaryEntry => e.type === 'cycle_summary');
  const fixes = entries.filter((e): e is PrResultEntry => e.type === 'pr_result');
  const merges = entries.filter((e): e is MergeResultEntry => e.type === 'merge_result');
  const undrafts = entries.filter((e): e is UndraftResultEntry => e.type === 'undraft_result');
  const mainBranch = entries.filter((e): e is MainBranchEntry => e.type === 'main_branch_result');
  const overlaps = entries.filter((e): e is OverlapWarningEntry => e.type === 'overlap_warning');

  // Fix outcome counts
  const fixByOutcome: Record<string, number> = {};
  for (const f of fixes) {
    fixByOutcome[f.outcome] = (fixByOutcome[f.outcome] ?? 0) + 1;
  }

  // Merge outcome counts
  const mergeByOutcome: Record<string, number> = {};
  for (const m of merges) {
    mergeByOutcome[m.outcome] = (mergeByOutcome[m.outcome] ?? 0) + 1;
  }

  // Issue type distribution (from fix entries)
  const issueTypes: Record<string, number> = {};
  for (const f of fixes) {
    for (const issue of f.issues ?? []) {
      issueTypes[issue] = (issueTypes[issue] ?? 0) + 1;
    }
  }

  // Most-touched PRs
  const prTouched = new Map<number, PrTouchInfo>();
  for (const f of fixes) {
    const existing = prTouched.get(f.pr_num);
    if (existing) {
      existing.attempts++;
      for (const issue of f.issues ?? []) {
        if (!existing.issues.includes(issue)) existing.issues.push(issue);
      }
      if (f.outcome === 'max-turns') existing.abandoned = true;
    } else {
      prTouched.set(f.pr_num, {
        attempts: 1,
        issues: [...(f.issues ?? [])],
        abandoned: f.outcome === 'max-turns',
      });
    }
  }

  // Performance metrics (only for non-dry-run fixes with elapsed time)
  const realFixes = fixes.filter((f) => f.outcome !== 'dry-run' && f.elapsed_s > 0);
  const fixTimes = realFixes.map((f) => f.elapsed_s);
  const sortedTimes = [...fixTimes].sort((a, b) => a - b);
  const maxEntry = realFixes.reduce(
    (max, f) => (f.elapsed_s > (max?.elapsed_s ?? 0) ? f : max),
    null as PrResultEntry | null,
  );

  // Cycle averages
  const totalScanned = cycles.reduce((sum, c) => sum + c.prs_scanned, 0);
  const totalQueue = cycles.reduce((sum, c) => sum + c.queue_size, 0);

  // Main branch outcome counts
  const mainByOutcome: Record<string, number> = {};
  for (const m of mainBranch) {
    mainByOutcome[m.outcome] = (mainByOutcome[m.outcome] ?? 0) + 1;
  }

  return {
    cycles: {
      total: cycles.length,
      avgScanned: cycles.length > 0 ? totalScanned / cycles.length : 0,
      avgQueueSize: cycles.length > 0 ? totalQueue / cycles.length : 0,
    },
    fixes: {
      total: fixes.length,
      byOutcome: fixByOutcome,
    },
    merges: {
      total: merges.length,
      byOutcome: mergeByOutcome,
    },
    undrafts: {
      total: undrafts.length,
    },
    issueTypes,
    prTouched,
    performance: {
      avgFixTime: fixTimes.length > 0 ? fixTimes.reduce((a, b) => a + b, 0) / fixTimes.length : 0,
      medianFixTime:
        sortedTimes.length > 0
          ? sortedTimes.length % 2 === 0
            ? (sortedTimes[sortedTimes.length / 2 - 1] + sortedTimes[sortedTimes.length / 2]) / 2
            : sortedTimes[Math.floor(sortedTimes.length / 2)]
          : 0,
      maxFixTime: sortedTimes.length > 0 ? sortedTimes[sortedTimes.length - 1] : 0,
      maxFixPr: maxEntry?.pr_num ?? null,
    },
    mainBranch: {
      total: mainBranch.length,
      byOutcome: mainByOutcome,
    },
    overlaps: overlaps.length,
  };
}
