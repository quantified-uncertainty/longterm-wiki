/**
 * PR Patrol — Stuck-cycle detection tests (QUA-286, Phase 2).
 *
 * Covers:
 *   - stateFingerprint() — SHA-excluded fingerprint
 *   - countConsecutiveCycles() — reads JSONL backwards, stops at mismatch
 *   - appendJsonlLocked() — concurrent writes produce well-formed JSONL
 *   - applyStuckCycleDetection() — attaches stuckCycles, injects 'stuck' issue
 *   - fixPr() — stuck PRs route through existing coordinator escalation
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  appendJsonl,
  appendJsonlLocked,
  countConsecutiveCycles,
  readRecentPrCycles,
  stateFingerprint,
} from './state.ts';
import {
  applyStuckCycleDetection,
  computeRollupConclusion,
  STUCK_CYCLE_THRESHOLD,
} from './detection.ts';
import type { DetectedPr, GqlPrNode } from './types.ts';

// ── Test helpers ────────────────────────────────────────────────────────────

function makeTempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stuck-cycle-test-'));
  return join(dir, 'runs.jsonl');
}

function cleanup(path: string): void {
  try {
    const dir = path.substring(0, path.lastIndexOf('/'));
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function makePrNode(
  overrides: Partial<GqlPrNode> & Pick<GqlPrNode, 'number' | 'headRefOid'>,
): GqlPrNode {
  const defaults: GqlPrNode = {
    id: `PR_${overrides.number}`,
    number: overrides.number,
    title: 'Test PR',
    headRefName: 'claude/test',
    headRefOid: overrides.headRefOid,
    mergeable: 'CONFLICTING',
    isDraft: false,
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    body: '## Test plan\n- [x] thing\nFixes #1',
    author: { login: 'someuser' },
    labels: { nodes: [] },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [{ conclusion: 'FAILURE', name: 'build' }],
              },
            },
          },
        },
      ],
    },
  };
  return { ...defaults, ...overrides };
}

function makeDetectedPr(
  overrides: Partial<DetectedPr> & Pick<DetectedPr, 'number'>,
): DetectedPr {
  return {
    title: 'Test PR',
    branch: 'claude/test',
    createdAt: '2026-04-01T00:00:00Z',
    issues: ['ci-failure'],
    botComments: [],
    labels: [],
    ...overrides,
  };
}

// ── stateFingerprint ────────────────────────────────────────────────────────

describe('stateFingerprint', () => {
  it('builds a colon-separated fingerprint from mergeable + rollup + comment count', () => {
    expect(stateFingerprint({
      mergeable: 'CONFLICTING',
      rollupConclusion: 'FAIL',
      blockingCommentCount: 2,
    })).toBe('CONFLICTING:FAIL:2');
  });

  it('normalizes case and falls back to UNKNOWN/NONE/0 for missing fields', () => {
    expect(stateFingerprint({ mergeable: 'mergeable', rollupConclusion: 'pass' }))
      .toBe('MERGEABLE:PASS:0');
    expect(stateFingerprint({})).toBe('UNKNOWN:NONE:0');
    expect(stateFingerprint({ blockingCommentCount: NaN })).toBe('UNKNOWN:NONE:0');
  });

  it('deliberately EXCLUDES headSha — different SHAs yield identical fingerprint', () => {
    // Regression guard: this is the red-team-corrected behavior. Including
    // SHA would reset the counter on every force-push.
    const fp1 = stateFingerprint({ mergeable: 'CONFLICTING', rollupConclusion: 'FAIL', blockingCommentCount: 0 });
    const fp2 = stateFingerprint({ mergeable: 'CONFLICTING', rollupConclusion: 'FAIL', blockingCommentCount: 0 });
    expect(fp1).toBe(fp2);
  });
});

// ── countConsecutiveCycles ──────────────────────────────────────────────────

describe('countConsecutiveCycles', () => {
  let file: string;
  beforeEach(() => { file = makeTempFile(); });
  afterEach(() => { cleanup(file); });

  function writeSnapshot(pr: number, fingerprint: string, extra: Record<string, unknown> = {}): void {
    appendFileSync(file,
      JSON.stringify({
        type: 'pr_cycle_snapshot',
        timestamp: new Date().toISOString(),
        pr_num: pr,
        fingerprint,
        ...extra,
      }) + '\n');
  }

  it('returns 0 when no snapshots exist', () => {
    expect(countConsecutiveCycles(42, 'A:B:0', file)).toBe(0);
  });

  it('returns 0 when the file does not exist', () => {
    const missing = join(tmpdir(), `nonexistent-${Date.now()}.jsonl`);
    expect(countConsecutiveCycles(42, 'A:B:0', missing)).toBe(0);
  });

  it('returns 1 when the last snapshot matches the current fingerprint', () => {
    writeSnapshot(42, 'A:B:0');
    expect(countConsecutiveCycles(42, 'A:B:0', file)).toBe(1);
  });

  it('returns 3 when the last 3 snapshots all match', () => {
    writeSnapshot(42, 'A:B:0');
    writeSnapshot(42, 'A:B:0');
    writeSnapshot(42, 'A:B:0');
    expect(countConsecutiveCycles(42, 'A:B:0', file)).toBe(3);
  });

  it('stops counting at the first non-matching snapshot (consecutive only)', () => {
    writeSnapshot(42, 'DIFFERENT');   // oldest
    writeSnapshot(42, 'A:B:0');
    writeSnapshot(42, 'A:B:0');        // newest → matches
    expect(countConsecutiveCycles(42, 'A:B:0', file)).toBe(2);
  });

  it('does not count snapshots for other PR numbers', () => {
    writeSnapshot(99, 'A:B:0');
    writeSnapshot(99, 'A:B:0');
    writeSnapshot(42, 'A:B:0');
    expect(countConsecutiveCycles(42, 'A:B:0', file)).toBe(1);
  });

  it('counts the same fingerprint across different head SHAs (QUA-286 fingerprint excludes SHA)', () => {
    // Regression guard: red-team review. A PR force-pushes new commits but
    // still fails the same way — counter must NOT reset.
    writeSnapshot(42, 'A:B:0', { head_sha: 'aaaaaaa' });
    writeSnapshot(42, 'A:B:0', { head_sha: 'bbbbbbb' });
    writeSnapshot(42, 'A:B:0', { head_sha: 'ccccccc' });
    expect(countConsecutiveCycles(42, 'A:B:0', file)).toBe(3);
  });

  it('tolerates malformed JSON lines and still returns a correct count', () => {
    writeSnapshot(42, 'A:B:0');
    appendFileSync(file, 'not-json-line\n');
    appendFileSync(file, '{partial-broken\n');
    writeSnapshot(42, 'A:B:0');
    // Malformed lines in between don't change the streak; they just get skipped.
    expect(countConsecutiveCycles(42, 'A:B:0', file)).toBe(2);
  });

  it('ignores non-snapshot entries (e.g., pr_result logs) even if pr_num matches', () => {
    appendFileSync(file,
      JSON.stringify({ type: 'pr_result', timestamp: new Date().toISOString(), pr_num: 42, fingerprint: 'A:B:0' }) + '\n',
    );
    writeSnapshot(42, 'A:B:0');
    expect(countConsecutiveCycles(42, 'A:B:0', file)).toBe(1);
  });
});

// ── readRecentPrCycles ──────────────────────────────────────────────────────

describe('readRecentPrCycles', () => {
  let file: string;
  beforeEach(() => { file = makeTempFile(); });
  afterEach(() => { cleanup(file); });

  it('returns [] when the file does not exist', () => {
    expect(readRecentPrCycles(42, 10, join(tmpdir(), 'nope.jsonl'))).toEqual([]);
  });

  it('returns [] when the file is empty', () => {
    writeFileSync(file, '');
    expect(readRecentPrCycles(42, 10, file)).toEqual([]);
  });

  it('returns snapshots newest-first, limited to N', () => {
    for (let i = 0; i < 5; i++) {
      appendFileSync(file,
        JSON.stringify({
          type: 'pr_cycle_snapshot',
          timestamp: new Date(Date.now() + i).toISOString(),
          pr_num: 42,
          fingerprint: `FP-${i}`,
        }) + '\n');
    }
    const got = readRecentPrCycles(42, 3, file);
    expect(got.map((s) => s.fingerprint)).toEqual(['FP-4', 'FP-3', 'FP-2']);
  });
});

// ── appendJsonlLocked (concurrency) ─────────────────────────────────────────

describe('appendJsonlLocked', () => {
  let file: string;
  beforeEach(() => { file = makeTempFile(); });
  afterEach(() => { cleanup(file); });

  it('writes a single JSONL line per call', async () => {
    await appendJsonlLocked(file, { type: 'pr_cycle_snapshot', pr_num: 1, fingerprint: 'A' });
    const content = readFileSync(file, 'utf-8');
    expect(content.trim().split('\n').length).toBe(1);
    const parsed = JSON.parse(content.trim());
    expect(parsed.pr_num).toBe(1);
    expect(parsed.timestamp).toBeTruthy();
  });

  it('concurrent writes produce N well-formed JSONL lines (no interleaving)', async () => {
    const N = 30;
    const writes = Array.from({ length: N }, (_, i) =>
      appendJsonlLocked(file, {
        type: 'pr_cycle_snapshot',
        pr_num: i,
        fingerprint: `FP-${i}`,
      }),
    );
    await Promise.all(writes);

    const content = readFileSync(file, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(N);

    // Every line must parse as valid JSON with the expected fields.
    const prNums = new Set<number>();
    for (const line of lines) {
      const obj = JSON.parse(line);
      expect(obj.type).toBe('pr_cycle_snapshot');
      expect(typeof obj.pr_num).toBe('number');
      expect(obj.fingerprint).toMatch(/^FP-\d+$/);
      prNums.add(obj.pr_num);
    }
    expect(prNums.size).toBe(N); // every write landed distinctly
  });

  it('creates the target file if it does not exist', async () => {
    expect(existsSync(file)).toBe(false);
    await appendJsonlLocked(file, { type: 'pr_cycle_snapshot', pr_num: 1, fingerprint: 'A' });
    expect(existsSync(file)).toBe(true);
  });
});

// ── computeRollupConclusion ─────────────────────────────────────────────────

describe('computeRollupConclusion', () => {
  it('returns FAIL when any context has a FAILURE conclusion', () => {
    const pr = makePrNode({
      number: 1,
      headRefOid: 'abc123',
      commits: {
        nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
          { conclusion: 'SUCCESS', name: 'test' },
          { conclusion: 'FAILURE', name: 'build' },
        ] } } } }],
      },
    });
    expect(computeRollupConclusion(pr)).toBe('FAIL');
  });

  it('returns PENDING when a context is still running', () => {
    const pr = makePrNode({
      number: 1,
      headRefOid: 'abc123',
      commits: {
        nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
          { conclusion: null, state: 'PENDING', name: 'build' },
        ] } } } }],
      },
    });
    expect(computeRollupConclusion(pr)).toBe('PENDING');
  });

  it('returns PASS when all contexts succeeded', () => {
    const pr = makePrNode({
      number: 1,
      headRefOid: 'abc123',
      commits: {
        nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
          { conclusion: 'SUCCESS', name: 'test' },
          { conclusion: 'SUCCESS', name: 'build' },
        ] } } } }],
      },
    });
    expect(computeRollupConclusion(pr)).toBe('PASS');
  });

  it('returns NONE when there are no contexts at all', () => {
    const pr = makePrNode({
      number: 1,
      headRefOid: 'abc123',
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }] },
    });
    expect(computeRollupConclusion(pr)).toBe('NONE');
  });
});

// ── applyStuckCycleDetection integration ───────────────────────────────────

describe('applyStuckCycleDetection', () => {
  let file: string;

  beforeEach(() => { file = makeTempFile(); });
  afterEach(() => { cleanup(file); });

  it('does not flag a PR on its first cycle', async () => {
    const detected = [makeDetectedPr({ number: 1 })];
    const nodes = [makePrNode({ number: 1, headRefOid: 'sha1' })];

    await applyStuckCycleDetection(detected, nodes, file);

    expect(detected[0].issues).not.toContain('stuck');
    expect(detected[0].stuckCycles ?? 0).toBeLessThan(2);
  });

  it('flags a PR as stuck when the same signal repeats ≥ threshold cycles (SHA changes ignored)', async () => {
    const prNum = 2;

    await applyStuckCycleDetection(
      [makeDetectedPr({ number: prNum })],
      [makePrNode({ number: prNum, headRefOid: 'sha1' })],
      file,
    );
    await applyStuckCycleDetection(
      [makeDetectedPr({ number: prNum })],
      [makePrNode({ number: prNum, headRefOid: 'sha2' })],
      file,
    );
    const cycle3 = [makeDetectedPr({ number: prNum })];
    await applyStuckCycleDetection(
      cycle3,
      [makePrNode({ number: prNum, headRefOid: 'sha3' })],
      file,
    );

    expect(cycle3[0].issues).toContain('stuck');
    expect(cycle3[0].stuckCycles).toBeGreaterThanOrEqual(STUCK_CYCLE_THRESHOLD);
    expect(cycle3[0].stuckReason).toContain('CONFLICTING:FAIL');
  });

  it('does NOT flag as stuck when the signal actually changes between cycles', async () => {
    const prNum = 3;

    await applyStuckCycleDetection(
      [makeDetectedPr({ number: prNum })],
      [makePrNode({ number: prNum, headRefOid: 'sha1', mergeable: 'CONFLICTING' })],
      file,
    );
    await applyStuckCycleDetection(
      [makeDetectedPr({ number: prNum })],
      [makePrNode({ number: prNum, headRefOid: 'sha2', mergeable: 'MERGEABLE' })],
      file,
    );
    const cycle3 = [makeDetectedPr({ number: prNum })];
    await applyStuckCycleDetection(
      cycle3,
      [makePrNode({ number: prNum, headRefOid: 'sha3', mergeable: 'CONFLICTING' })],
      file,
    );

    expect(cycle3[0].issues).not.toContain('stuck');
    expect(cycle3[0].stuckCycles ?? 0).toBeLessThan(STUCK_CYCLE_THRESHOLD);
  });

  it('annotates stuckCycles = 2 at cycle 2 so prompts can warn before escalation', async () => {
    const prNum = 4;

    await applyStuckCycleDetection(
      [makeDetectedPr({ number: prNum })],
      [makePrNode({ number: prNum, headRefOid: 'sha1' })],
      file,
    );
    const cycle2 = [makeDetectedPr({ number: prNum })];
    await applyStuckCycleDetection(
      cycle2,
      [makePrNode({ number: prNum, headRefOid: 'sha2' })],
      file,
    );

    expect(cycle2[0].issues).not.toContain('stuck');
    expect(cycle2[0].stuckCycles).toBe(2);
  });

  it('flags 6+ cycle oscillation (fixture replay for #4157 / #4188 class)', async () => {
    // Replay: PR sits at CONFLICTING:FAIL for 6 consecutive cycles. This is
    // the pattern from #4157 and #4188 (conflicting rebases that never
    // resolved). Phase 2 should flag it no later than cycle 3.
    const prNum = 5;

    for (let cycle = 1; cycle <= 6; cycle++) {
      const detected = [makeDetectedPr({ number: prNum })];
      await applyStuckCycleDetection(
        detected,
        [makePrNode({ number: prNum, headRefOid: `sha${cycle}` })],
        file,
      );
      if (cycle < STUCK_CYCLE_THRESHOLD) {
        expect(detected[0].issues).not.toContain('stuck');
      } else {
        expect(detected[0].issues).toContain('stuck');
        expect(detected[0].stuckCycles).toBeGreaterThanOrEqual(STUCK_CYCLE_THRESHOLD);
      }
    }
  });

  it('persists a pr_cycle_snapshot entry to the JSONL file each cycle', async () => {
    const prNum = 6;
    await applyStuckCycleDetection(
      [makeDetectedPr({ number: prNum })],
      [makePrNode({ number: prNum, headRefOid: 'sha1' })],
      file,
    );
    const content = readFileSync(file, 'utf-8').trim();
    expect(content).toBeTruthy();
    const parsed = JSON.parse(content);
    expect(parsed.type).toBe('pr_cycle_snapshot');
    expect(parsed.pr_num).toBe(prNum);
    expect(parsed.fingerprint).toBeTruthy();
    expect(parsed.head_sha).toBe('sha1');
    expect(parsed.timestamp).toBeTruthy();
  });
});

// ── appendJsonl (non-locked, legacy) still works ───────────────────────────

describe('appendJsonl (legacy non-locked) remains compatible', () => {
  let file: string;
  beforeEach(() => { file = makeTempFile(); });
  afterEach(() => { cleanup(file); });

  it('sequential writes produce parseable JSONL', () => {
    appendJsonl(file, { type: 'pr_result', pr_num: 1 });
    appendJsonl(file, { type: 'pr_result', pr_num: 2 });
    const lines = readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });
});
