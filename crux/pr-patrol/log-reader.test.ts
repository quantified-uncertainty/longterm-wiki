import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readAllEntries,
  parseDuration,
  filterByTime,
  filterByType,
  filterByPr,
  filterByOutcome,
  computeStats,
  type LogEntry,
} from './log-reader.ts';

// ── Test helpers ────────────────────────────────────────────────────────────

let testDir: string;
let testFile: string;

function writeJsonl(entries: Record<string, unknown>[]): void {
  writeFileSync(testFile, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function makeTimestamp(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 3600_000).toISOString();
}

const FIXTURE_ENTRIES: Record<string, unknown>[] = [
  {
    type: 'cycle_summary',
    timestamp: makeTimestamp(48),
    cycle_number: 1,
    prs_scanned: 10,
    queue_size: 3,
    pr_processed: 100,
    merge_candidates: 1,
    merge_eligible: 0,
  },
  {
    type: 'pr_result',
    timestamp: makeTimestamp(47),
    pr_num: 100,
    issues: ['conflict', 'ci-failure'],
    outcome: 'fixed',
    elapsed_s: 120,
  },
  {
    type: 'merge_result',
    timestamp: makeTimestamp(46),
    pr_num: 99,
    outcome: 'merged',
  },
  {
    type: 'cycle_summary',
    timestamp: makeTimestamp(24),
    cycle_number: 2,
    prs_scanned: 8,
    queue_size: 2,
    pr_processed: 101,
    merge_candidates: 0,
    merge_eligible: 0,
  },
  {
    type: 'pr_result',
    timestamp: makeTimestamp(23),
    pr_num: 101,
    issues: ['missing-testplan'],
    outcome: 'max-turns',
    elapsed_s: 340,
    reason: 'Hit max turns (40)',
  },
  {
    type: 'overlap_warning',
    timestamp: makeTimestamp(22),
    pr_a: 101,
    pr_b: 102,
    shared_files: 3,
  },
  {
    type: 'main_branch_result',
    timestamp: makeTimestamp(10),
    run_id: 12345,
    sha: 'abc123',
    outcome: 'fixed',
    elapsed_s: 60,
  },
  {
    type: 'undraft_result',
    timestamp: makeTimestamp(5),
    pr_num: 103,
    outcome: 'undrafted',
  },
  {
    type: 'pr_result',
    timestamp: makeTimestamp(2),
    pr_num: 100,
    issues: ['ci-failure'],
    outcome: 'error',
    elapsed_s: 15,
    reason: 'Exit code: 1',
  },
  {
    type: 'cycle_summary',
    timestamp: makeTimestamp(1),
    cycle_number: 3,
    prs_scanned: 12,
    queue_size: 4,
    pr_processed: null,
    merge_candidates: 2,
    merge_eligible: 1,
  },
];

beforeEach(() => {
  testDir = join(tmpdir(), `pr-patrol-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  testFile = join(testDir, 'test.jsonl');
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
});

// ── readAllEntries ──────────────────────────────────────────────────────────

describe('readAllEntries', () => {
  it('returns empty array for nonexistent file', () => {
    expect(readAllEntries('/nonexistent/path.jsonl')).toEqual([]);
  });

  it('returns empty array for empty file', () => {
    writeFileSync(testFile, '');
    expect(readAllEntries(testFile)).toEqual([]);
  });

  it('parses valid JSONL entries', () => {
    writeJsonl(FIXTURE_ENTRIES);
    const entries = readAllEntries(testFile);
    expect(entries).toHaveLength(FIXTURE_ENTRIES.length);
    expect(entries[0].type).toBe('cycle_summary');
    expect(entries[1].type).toBe('pr_result');
  });

  it('skips malformed lines', () => {
    writeFileSync(testFile, 'not json\n{"type":"pr_result","timestamp":"2026-01-01T00:00:00Z","pr_num":1,"issues":[],"outcome":"fixed","elapsed_s":10}\n{}\n');
    const entries = readAllEntries(testFile);
    // Only the valid entry with type and timestamp is kept; {} is skipped (no type/timestamp)
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('pr_result');
  });
});

// ── parseDuration ───────────────────────────────────────────────────────────

describe('parseDuration', () => {
  it('parses hours', () => {
    expect(parseDuration('1h')).toBe(3600_000);
    expect(parseDuration('24h')).toBe(24 * 3600_000);
  });

  it('parses days', () => {
    expect(parseDuration('7d')).toBe(7 * 86400_000);
    expect(parseDuration('30d')).toBe(30 * 86400_000);
  });

  it('throws on invalid format', () => {
    expect(() => parseDuration('abc')).toThrow('Invalid duration');
    expect(() => parseDuration('5m')).toThrow('Invalid duration');
    expect(() => parseDuration('')).toThrow('Invalid duration');
  });
});

// ── filterByTime ────────────────────────────────────────────────────────────

describe('filterByTime', () => {
  it('filters entries by time window', () => {
    writeJsonl(FIXTURE_ENTRIES);
    const all = readAllEntries(testFile);

    const last12h = filterByTime(all, '12h');
    // Should include entries from 10h, 5h, 2h, 1h ago
    expect(last12h.length).toBe(4);

    const last6h = filterByTime(all, '6h');
    // Should include entries from 5h, 2h, 1h ago
    expect(last6h.length).toBe(3);
  });
});

// ── filterByType ────────────────────────────────────────────────────────────

describe('filterByType', () => {
  it('filters by shorthand type', () => {
    writeJsonl(FIXTURE_ENTRIES);
    const all = readAllEntries(testFile);

    expect(filterByType(all, 'pr').length).toBe(3);
    expect(filterByType(all, 'merge').length).toBe(1);
    expect(filterByType(all, 'cycle').length).toBe(3);
    expect(filterByType(all, 'main').length).toBe(1);
    expect(filterByType(all, 'overlap').length).toBe(1);
    expect(filterByType(all, 'undraft').length).toBe(1);
  });

  it('also accepts full type name', () => {
    writeJsonl(FIXTURE_ENTRIES);
    const all = readAllEntries(testFile);
    expect(filterByType(all, 'pr_result').length).toBe(3);
  });
});

// ── filterByPr ──────────────────────────────────────────────────────────────

describe('filterByPr', () => {
  it('filters entries by PR number', () => {
    writeJsonl(FIXTURE_ENTRIES);
    const all = readAllEntries(testFile);

    const pr100 = filterByPr(all, 100);
    // pr_result x2 (fixed at 47h ago + error at 2h ago) + cycle_summary (pr_processed=100)
    expect(pr100.length).toBe(3);
  });

  it('includes overlap warnings', () => {
    writeJsonl(FIXTURE_ENTRIES);
    const all = readAllEntries(testFile);
    const pr102 = filterByPr(all, 102);
    expect(pr102.length).toBe(1);
    expect(pr102[0].type).toBe('overlap_warning');
  });
});

// ── filterByOutcome ─────────────────────────────────────────────────────────

describe('filterByOutcome', () => {
  it('filters by outcome value', () => {
    writeJsonl(FIXTURE_ENTRIES);
    const all = readAllEntries(testFile);

    expect(filterByOutcome(all, 'fixed').length).toBe(2); // pr_result + main_branch_result
    expect(filterByOutcome(all, 'merged').length).toBe(1);
    expect(filterByOutcome(all, 'error').length).toBe(1);
    expect(filterByOutcome(all, 'max-turns').length).toBe(1);
  });
});

// ── computeStats ────────────────────────────────────────────────────────────

describe('computeStats', () => {
  it('computes aggregate stats from entries', () => {
    writeJsonl(FIXTURE_ENTRIES);
    const all = readAllEntries(testFile);
    const stats = computeStats(all);

    // Cycles
    expect(stats.cycles.total).toBe(3);
    expect(stats.cycles.avgScanned).toBe(10); // (10+8+12)/3

    // Fix outcomes (fixed + max-turns + error = 3)
    expect(stats.fixes.total).toBe(3);
    expect(stats.fixes.byOutcome['fixed']).toBe(1);
    expect(stats.fixes.byOutcome['max-turns']).toBe(1);
    expect(stats.fixes.byOutcome['error']).toBe(1);

    // Merge outcomes
    expect(stats.merges.total).toBe(1);
    expect(stats.merges.byOutcome['merged']).toBe(1);

    // Undrafts
    expect(stats.undrafts.total).toBe(1);

    // Issue types
    expect(stats.issueTypes['conflict']).toBe(1);
    expect(stats.issueTypes['ci-failure']).toBe(2);
    expect(stats.issueTypes['missing-testplan']).toBe(1);

    // Most-touched PRs
    expect(stats.prTouched.get(100)?.attempts).toBe(2);
    expect(stats.prTouched.get(100)?.issues).toContain('conflict');
    expect(stats.prTouched.get(100)?.issues).toContain('ci-failure');

    // Performance
    expect(stats.performance.avgFixTime).toBeGreaterThan(0);
    expect(stats.performance.maxFixTime).toBe(340);

    // Main branch
    expect(stats.mainBranch.total).toBe(1);
    expect(stats.mainBranch.byOutcome['fixed']).toBe(1);

    // Overlaps
    expect(stats.overlaps).toBe(1);
  });

  it('handles empty entries', () => {
    const stats = computeStats([]);
    expect(stats.cycles.total).toBe(0);
    expect(stats.fixes.total).toBe(0);
    expect(stats.performance.avgFixTime).toBe(0);
  });
});
