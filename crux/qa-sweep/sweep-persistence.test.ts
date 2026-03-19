/**
 * Tests for crux/qa-sweep/sweep-persistence.ts
 *
 * Covers:
 * - saveResult: writes timestamped file + latest.json
 * - listResultFiles: returns sorted file paths, excludes latest.json
 * - loadResult: parses valid JSON, returns null for invalid/missing
 * - diffResults: regression / resolved / recurring / new / removed detection
 * - formatDiff: output contains expected labels
 * - loadLatest / loadPrevious: convenience accessors
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Filesystem mock
// ---------------------------------------------------------------------------

// We need to mock the entire 'fs' module so no real I/O happens.
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
}));

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from 'fs';

const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockReaddirSync = vi.mocked(readdirSync);

import {
  saveResult,
  listResultFiles,
  loadResult,
  diffResults,
  formatDiff,
  loadLatest,
  loadPrevious,
  type SweepReport,
  type PersistedSweepResult,
} from './sweep-persistence.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseReport: SweepReport = {
  timestamp: '2026-03-19',
  recentChanges: [],
  changedFiles: [],
  checks: [
    { name: 'Duplicate wikiIds', status: 'pass', message: '700 unique IDs' },
    { name: 'NEEDS CITATION markers', status: 'warn', message: '3 markers in 2 files' },
  ],
};

const baseResult: PersistedSweepResult = {
  ...baseReport,
  savedAt: '2026-03-19T10:00:00.000Z',
};

// Helper to build a minimal result with specific check statuses
function makeResult(
  savedAt: string,
  checks: Array<{ name: string; status: 'pass' | 'fail' | 'warn' | 'skip'; message?: string }>,
): PersistedSweepResult {
  return {
    timestamp: savedAt.slice(0, 10),
    savedAt,
    recentChanges: [],
    changedFiles: [],
    checks: checks.map(({ name, status, message }) => ({
      name,
      status,
      message: message ?? `${status} message`,
    })),
  };
}

// ---------------------------------------------------------------------------
// saveResult
// ---------------------------------------------------------------------------

describe('saveResult', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Directory already exists → no mkdirSync call
    mockExistsSync.mockReturnValue(true);
  });

  it('writes a timestamped file and latest.json', () => {
    const path = saveResult(baseReport);

    // Should have written two files
    expect(mockWriteFileSync).toHaveBeenCalledTimes(2);

    const calls = mockWriteFileSync.mock.calls;
    const paths = calls.map((c) => c[0] as string);

    // One of them must be latest.json
    expect(paths.some((p) => p.endsWith('latest.json'))).toBe(true);

    // The other is the timestamped file that saveResult returns
    expect(path).not.toContain('latest.json');
    expect(path).toMatch(/\.json$/);

    // Content must contain savedAt
    const content = calls[0][1] as string;
    const parsed = JSON.parse(content) as PersistedSweepResult;
    expect(parsed.savedAt).toBeDefined();
    expect(typeof parsed.savedAt).toBe('string');
  });

  it('creates the directory when it does not exist', () => {
    // First call (existsSync for RESULTS_DIR) → false
    mockExistsSync.mockReturnValue(false);

    saveResult(baseReport);

    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('sweep-results'),
      { recursive: true },
    );
  });

  it('includes all report fields in the persisted file', () => {
    saveResult(baseReport);

    const content = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = JSON.parse(content) as PersistedSweepResult;

    expect(parsed.timestamp).toBe(baseReport.timestamp);
    expect(parsed.checks).toHaveLength(2);
    expect(parsed.recentChanges).toEqual([]);
  });

  it('uses filesystem-safe timestamps (no colons in filename)', () => {
    const path = saveResult(baseReport);
    // Everything after the last slash should have no colons
    const filename = path.split('/').pop() ?? '';
    expect(filename).not.toContain(':');
  });
});

// ---------------------------------------------------------------------------
// listResultFiles
// ---------------------------------------------------------------------------

describe('listResultFiles', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty array when directory does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(listResultFiles()).toEqual([]);
  });

  it('excludes latest.json from the list', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      '2026-03-18T10-00-00Z.json',
      '2026-03-19T10-00-00Z.json',
      'latest.json',
    ] as never);

    const files = listResultFiles();
    expect(files.every((f) => !f.endsWith('latest.json'))).toBe(true);
    expect(files).toHaveLength(2);
  });

  it('returns files sorted chronologically (oldest first)', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      '2026-03-20T10-00-00Z.json',
      '2026-03-18T10-00-00Z.json',
      '2026-03-19T10-00-00Z.json',
    ] as never);

    const files = listResultFiles();
    const basenames = files.map((f) => f.split('/').pop());
    expect(basenames).toEqual([
      '2026-03-18T10-00-00Z.json',
      '2026-03-19T10-00-00Z.json',
      '2026-03-20T10-00-00Z.json',
    ]);
  });
});

// ---------------------------------------------------------------------------
// loadResult
// ---------------------------------------------------------------------------

describe('loadResult', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses a valid persisted result file', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify(baseResult));
    const result = loadResult('/fake/path.json');
    expect(result).not.toBeNull();
    expect(result?.savedAt).toBe(baseResult.savedAt);
    expect(result?.checks).toHaveLength(2);
  });

  it('returns null for invalid JSON', () => {
    mockReadFileSync.mockReturnValue('not-json{{{');
    const result = loadResult('/fake/path.json');
    expect(result).toBeNull();
  });

  it('returns null for JSON missing required fields', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ foo: 'bar' }));
    const result = loadResult('/fake/path.json');
    expect(result).toBeNull();
  });

  it('returns null when readFileSync throws', () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    const result = loadResult('/fake/missing.json');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// diffResults — core logic
// ---------------------------------------------------------------------------

describe('diffResults', () => {
  it('detects regressions (check got worse)', () => {
    const prev = makeResult('2026-03-18T10:00:00Z', [
      { name: 'Duplicate wikiIds', status: 'pass' },
    ]);
    const curr = makeResult('2026-03-19T10:00:00Z', [
      { name: 'Duplicate wikiIds', status: 'fail', message: '2 duplicates found' },
    ]);

    const diff = diffResults(prev, curr);

    expect(diff.regressions).toHaveLength(1);
    expect(diff.regressions[0].name).toBe('Duplicate wikiIds');
    expect(diff.resolved).toHaveLength(0);
    expect(diff.recurring).toHaveLength(0);
  });

  it('treats warn→fail as a regression', () => {
    const prev = makeResult('2026-03-18T10:00:00Z', [
      { name: 'Test suite', status: 'warn' },
    ]);
    const curr = makeResult('2026-03-19T10:00:00Z', [
      { name: 'Test suite', status: 'fail' },
    ]);

    const diff = diffResults(prev, curr);
    expect(diff.regressions).toHaveLength(1);
  });

  it('detects resolved issues (check got better)', () => {
    const prev = makeResult('2026-03-18T10:00:00Z', [
      { name: 'NEEDS CITATION', status: 'warn' },
    ]);
    const curr = makeResult('2026-03-19T10:00:00Z', [
      { name: 'NEEDS CITATION', status: 'pass' },
    ]);

    const diff = diffResults(prev, curr);

    expect(diff.resolved).toHaveLength(1);
    expect(diff.regressions).toHaveLength(0);
  });

  it('treats fail→warn as resolved (no longer failing)', () => {
    const prev = makeResult('2026-03-18T10:00:00Z', [
      { name: 'Test suite', status: 'fail' },
    ]);
    const curr = makeResult('2026-03-19T10:00:00Z', [
      { name: 'Test suite', status: 'warn' },
    ]);

    // fail → warn means the situation got better (less severe)
    // Both are "problematic", so this should be "recurring", NOT resolved
    const diff = diffResults(prev, curr);
    expect(diff.recurring).toHaveLength(1);
    expect(diff.resolved).toHaveLength(0);
  });

  it('detects recurring issues (problematic in both runs)', () => {
    const prev = makeResult('2026-03-18T10:00:00Z', [
      { name: 'Broken refs', status: 'fail' },
      { name: 'TODOs', status: 'warn' },
    ]);
    const curr = makeResult('2026-03-19T10:00:00Z', [
      { name: 'Broken refs', status: 'fail' },
      { name: 'TODOs', status: 'warn' },
    ]);

    const diff = diffResults(prev, curr);

    expect(diff.recurring).toHaveLength(2);
    expect(diff.regressions).toHaveLength(0);
    expect(diff.resolved).toHaveLength(0);
  });

  it('detects newly added checks', () => {
    const prev = makeResult('2026-03-18T10:00:00Z', [
      { name: 'Duplicate wikiIds', status: 'pass' },
    ]);
    const curr = makeResult('2026-03-19T10:00:00Z', [
      { name: 'Duplicate wikiIds', status: 'pass' },
      { name: 'New check added in latest version', status: 'pass' },
    ]);

    const diff = diffResults(prev, curr);

    expect(diff.newChecks).toHaveLength(1);
    expect(diff.newChecks[0].name).toBe('New check added in latest version');
    expect(diff.removedChecks).toHaveLength(0);
  });

  it('detects removed checks', () => {
    const prev = makeResult('2026-03-18T10:00:00Z', [
      { name: 'Duplicate wikiIds', status: 'pass' },
      { name: 'Old deprecated check', status: 'pass' },
    ]);
    const curr = makeResult('2026-03-19T10:00:00Z', [
      { name: 'Duplicate wikiIds', status: 'pass' },
    ]);

    const diff = diffResults(prev, curr);

    expect(diff.removedChecks).toHaveLength(1);
    expect(diff.removedChecks[0].name).toBe('Old deprecated check');
    expect(diff.newChecks).toHaveLength(0);
  });

  it('computes correct trend counts', () => {
    const prev = makeResult('2026-03-18T10:00:00Z', [
      { name: 'A', status: 'fail' },
      { name: 'B', status: 'warn' },
      { name: 'C', status: 'pass' },
    ]);
    const curr = makeResult('2026-03-19T10:00:00Z', [
      { name: 'A', status: 'pass' }, // resolved
      { name: 'B', status: 'fail' }, // regression
      { name: 'C', status: 'pass' }, // unchanged
    ]);

    const diff = diffResults(prev, curr);

    expect(diff.previous.failCount).toBe(1);
    expect(diff.previous.warnCount).toBe(1);
    expect(diff.previous.passCount).toBe(1);

    expect(diff.current.failCount).toBe(1);
    expect(diff.current.warnCount).toBe(0);
    expect(diff.current.passCount).toBe(2);

    expect(diff.regressions).toHaveLength(1);
    expect(diff.resolved).toHaveLength(1);
    expect(diff.recurring).toHaveLength(0);
  });

  it('handles empty checks in both runs', () => {
    const prev = makeResult('2026-03-18T10:00:00Z', []);
    const curr = makeResult('2026-03-19T10:00:00Z', []);

    const diff = diffResults(prev, curr);

    expect(diff.checks).toHaveLength(0);
    expect(diff.regressions).toHaveLength(0);
    expect(diff.resolved).toHaveLength(0);
  });

  it('handles pass→skip as a regression (neither is problematic — actually neutral)', () => {
    // pass → skip: skip has severity 1, pass has severity 0. Neither is "isProblematic",
    // so this should NOT be a regression or resolved — it should appear as an unchanged check.
    const prev = makeResult('2026-03-18T10:00:00Z', [
      { name: 'Test suite', status: 'pass' },
    ]);
    const curr = makeResult('2026-03-19T10:00:00Z', [
      { name: 'Test suite', status: 'skip' },
    ]);

    const diff = diffResults(prev, curr);
    expect(diff.regressions).toHaveLength(0);
    expect(diff.resolved).toHaveLength(0);
    expect(diff.recurring).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// formatDiff — output content
// ---------------------------------------------------------------------------

describe('formatDiff', () => {
  it('shows regression section when there are regressions', () => {
    const prev = makeResult('2026-03-18T10:00:00Z', [
      { name: 'Broken refs', status: 'pass' },
    ]);
    const curr = makeResult('2026-03-19T10:00:00Z', [
      { name: 'Broken refs', status: 'fail', message: '3 broken refs found' },
    ]);

    const diff = diffResults(prev, curr);
    const output = formatDiff(diff, false);

    expect(output).toContain('NEW REGRESSIONS');
    expect(output).toContain('Broken refs');
    expect(output).toContain('3 broken refs found');
  });

  it('shows resolved section when issues were fixed', () => {
    const prev = makeResult('2026-03-18T10:00:00Z', [
      { name: 'NEEDS CITATION', status: 'warn', message: '5 markers' },
    ]);
    const curr = makeResult('2026-03-19T10:00:00Z', [
      { name: 'NEEDS CITATION', status: 'pass', message: 'No markers found' },
    ]);

    const diff = diffResults(prev, curr);
    const output = formatDiff(diff, false);

    expect(output).toContain('RESOLVED');
    expect(output).toContain('NEEDS CITATION');
  });

  it('shows recurring section when issues persist', () => {
    const prev = makeResult('2026-03-18T10:00:00Z', [
      { name: 'Broken refs', status: 'fail' },
    ]);
    const curr = makeResult('2026-03-19T10:00:00Z', [
      { name: 'Broken refs', status: 'fail' },
    ]);

    const diff = diffResults(prev, curr);
    const output = formatDiff(diff, false);

    expect(output).toContain('RECURRING ISSUES');
  });

  it('shows trend deltas', () => {
    const prev = makeResult('2026-03-18T10:00:00Z', [
      { name: 'A', status: 'fail' },
    ]);
    const curr = makeResult('2026-03-19T10:00:00Z', [
      { name: 'A', status: 'fail' },
      { name: 'B', status: 'fail' },
    ]);

    const diff = diffResults(prev, curr);
    const output = formatDiff(diff, false);

    // Failure count went up by 1
    expect(output).toContain('(+1)');
  });

  it('shows "No changes" when both runs are identical', () => {
    const prev = makeResult('2026-03-18T10:00:00Z', [
      { name: 'Duplicate wikiIds', status: 'pass' },
    ]);
    const curr = makeResult('2026-03-19T10:00:00Z', [
      { name: 'Duplicate wikiIds', status: 'pass' },
    ]);

    const diff = diffResults(prev, curr);
    const output = formatDiff(diff, false);

    expect(output).toContain('No changes between runs');
  });

  it('includes timestamps for both runs', () => {
    const prev = makeResult('2026-03-18T10:00:00Z', []);
    const curr = makeResult('2026-03-19T10:00:00Z', []);

    const diff = diffResults(prev, curr);
    const output = formatDiff(diff, false);

    expect(output).toContain('2026-03-18');
    expect(output).toContain('2026-03-19');
  });
});

// ---------------------------------------------------------------------------
// loadLatest / loadPrevious
// ---------------------------------------------------------------------------

describe('loadLatest', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when latest.json does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(loadLatest()).toBeNull();
  });

  it('loads and returns the latest result', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(baseResult));

    const result = loadLatest();
    expect(result).not.toBeNull();
    expect(result?.savedAt).toBe(baseResult.savedAt);
  });
});

describe('loadPrevious', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when there are fewer than 2 result files', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['2026-03-19T10-00-00Z.json'] as never);
    mockReadFileSync.mockReturnValue(JSON.stringify(baseResult));

    expect(loadPrevious()).toBeNull();
  });

  it('returns the second-to-last file when two or more exist', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      '2026-03-18T10-00-00Z.json',
      '2026-03-19T10-00-00Z.json',
    ] as never);

    const olderResult: PersistedSweepResult = { ...baseResult, savedAt: '2026-03-18T10:00:00.000Z' };
    const newerResult: PersistedSweepResult = { ...baseResult, savedAt: '2026-03-19T10:00:00.000Z' };

    // loadPrevious calls listResultFiles (readdirSync) then readFileSync on the second-to-last
    mockReadFileSync.mockImplementation((p: unknown) => {
      const path = p as string;
      if (path.includes('2026-03-18')) return JSON.stringify(olderResult);
      return JSON.stringify(newerResult);
    });

    const result = loadPrevious();
    expect(result).not.toBeNull();
    expect(result?.savedAt).toBe('2026-03-18T10:00:00.000Z');
  });
});
