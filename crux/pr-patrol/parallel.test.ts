/**
 * Tests for PR Patrol parallel dispatch — stale working-label cleanup logic.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import os from 'os';

import { ensureDirs } from './state.ts';
import { findIdleSlots, getLwDir } from './parallel.ts';

// ── Stale label detection (unit-testable pure logic) ─────────────────────────
//
// We test the PR-node filtering logic that determines which PRs have stale
// working labels. This logic lives inline in cleanStaleWorkingLabels but the
// key invariant is:
//   A label is stale  ⟺  no active lock file claims that PR number.

describe('cleanStaleLocks integration — getLwDir', () => {
  it('returns a path ending in /lw when invoked from a normal directory', () => {
    const lwDir = getLwDir();
    expect(typeof lwDir).toBe('string');
    expect(lwDir.length).toBeGreaterThan(0);
    // The directory either IS lw/ or has lw as a parent segment
    expect(lwDir).toMatch(/lw$/);
  });
});

// ── Lock file stale detection (exercises isLockStale indirectly via findIdleSlots) ──

describe('findIdleSlots — basic validation', () => {
  it('returns an empty array when lwDir does not exist', () => {
    const result = findIdleSlots('/tmp/nonexistent-dir-xyz-12345', [2, 10]);
    expect(result).toEqual([]);
  });

  it('returns an empty array for an empty lwDir', () => {
    const tmpDir = join(os.tmpdir(), `patrol-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      const result = findIdleSlots(tmpDir, [2, 10]);
      expect(result).toEqual([]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Stale label filtering — core logic ───────────────────────────────────────
//
// The key invariant: detectAllPrIssuesFromNodes filters out any PR whose
// labels include ANY_WORKING_LABELS. After cleanStaleWorkingLabels runs and
// strips the label from stale PRs' in-memory nodes, they must be detectable.

import { detectAllPrIssuesFromNodes } from './detection.ts';
import type { GqlPrNode, PatrolConfig } from './types.ts';
import { LABELS } from './types.ts';

const defaultConfig: PatrolConfig = {
  repo: 'test/repo',
  intervalSeconds: 60,
  maxTurns: 10,
  cooldownSeconds: 300,
  staleHours: 72,
  model: 'sonnet',
  skipPerms: false,
  once: false,
  dryRun: false,
  verbose: false,
  reflectionInterval: 5,
  timeoutMinutes: 30,
};

function makePrNode(overrides: Partial<GqlPrNode> = {}): GqlPrNode {
  return {
    id: 'PR_test_id',
    number: 1,
    title: 'Test PR',
    headRefName: 'claude/test',
    headRefOid: 'abc123def456',
    mergeable: 'MERGEABLE',
    isDraft: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2020-01-01T00:00:00Z', // old enough to be stale
    body: '## Summary\n\n- [x] Task done\n\n## Test plan\n\n- [x] Tests pass\n\nCloses #1',
    author: { login: 'testuser' },
    labels: { nodes: [] },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [{ conclusion: 'FAILURE', name: 'ci' }],
              },
            },
          },
        },
      ],
    },
    reviewThreads: { nodes: [] },
    ...overrides,
  };
}

describe('stale working-label effect on detection', () => {
  it('PR with pr-patrol:working label is invisible to the detector', () => {
    const pr = makePrNode({
      number: 100,
      labels: { nodes: [{ name: LABELS.PR_PATROL_WORKING }] },
    });
    const detected = detectAllPrIssuesFromNodes([pr], defaultConfig);
    expect(detected.find((r) => r.number === 100)).toBeUndefined();
  });

  it('PR without pr-patrol:working label is visible to the detector', () => {
    const pr = makePrNode({
      number: 101,
      labels: { nodes: [] },
    });
    const detected = detectAllPrIssuesFromNodes([pr], defaultConfig);
    expect(detected.find((r) => r.number === 101)).toBeDefined();
  });

  it('stripping pr-patrol:working from in-memory node makes PR re-detectable', () => {
    const pr = makePrNode({
      number: 102,
      labels: { nodes: [{ name: LABELS.PR_PATROL_WORKING }] },
    });

    // Before cleanup: invisible
    let detected = detectAllPrIssuesFromNodes([pr], defaultConfig);
    expect(detected.find((r) => r.number === 102)).toBeUndefined();

    // Simulate what cleanStaleWorkingLabels does to the in-memory node
    pr.labels = {
      nodes: pr.labels.nodes.filter((l) => l.name !== LABELS.PR_PATROL_WORKING),
    };

    // After cleanup: now visible (has ci-failure issue from the mock node)
    detected = detectAllPrIssuesFromNodes([pr], defaultConfig);
    expect(detected.find((r) => r.number === 102)).toBeDefined();
  });

  it('stripping label from one PR does not affect others', () => {
    const prA = makePrNode({
      number: 200,
      labels: { nodes: [{ name: LABELS.PR_PATROL_WORKING }] },
    });
    const prB = makePrNode({
      number: 201,
      labels: { nodes: [] },
    });

    // Strip from prA only
    prA.labels = { nodes: [] };

    const detected = detectAllPrIssuesFromNodes([prA, prB], defaultConfig);
    expect(detected.find((r) => r.number === 200)).toBeDefined();
    expect(detected.find((r) => r.number === 201)).toBeDefined();
  });

  it('PR with both working label and other labels retains other labels after strip', () => {
    const pr = makePrNode({
      number: 300,
      labels: {
        nodes: [
          { name: LABELS.PR_PATROL_WORKING },
          { name: LABELS.STAGE_APPROVED },
        ],
      },
    });

    pr.labels = {
      nodes: pr.labels.nodes.filter((l) => l.name !== LABELS.PR_PATROL_WORKING),
    };

    expect(pr.labels.nodes).toHaveLength(1);
    expect(pr.labels.nodes[0].name).toBe(LABELS.STAGE_APPROVED);
  });
});

// ── State directory (sanity check) ────────────────────────────────────────────

describe('ensureDirs', () => {
  beforeAll(() => {
    ensureDirs();
  });

  it('state dir exists after ensureDirs', async () => {
    const { STATE_DIR } = await import('./state.ts');
    expect(existsSync(STATE_DIR)).toBe(true);
  });
});
