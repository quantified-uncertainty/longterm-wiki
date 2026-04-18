/**
 * Tests for the dispatch pre-flight orchestration layer (QUA-437).
 *
 * `runSlotState` is covered by the real filesystem in a temp dir so we
 * exercise actual git behavior rather than mock out the shell. The
 * orchestrator `runPreflight` is tested with injected fakes for each
 * of its three signals.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runPreflight, runSlotState } from './preflight.ts';
import type { SessionContext } from '../session/session-context.ts';

function initRepoOnMain(dir: string): void {
  execSync('git init -b main', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email test@example.com', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name Test', { cwd: dir, stdio: 'ignore' });
  writeFileSync(join(dir, 'README.md'), 'hi\n');
  execSync('git add README.md && git commit -m init', { cwd: dir, stdio: 'ignore' });
}

const baseCtx: SessionContext = {
  slot: 10,
  branch: 'claude/qua-437',
  host: 'h',
  agentId: null,
};

describe('runSlotState', () => {
  it('reports non-existent dir as exists=false', () => {
    const state = runSlotState('/nonexistent/path/deep/a99');
    expect(state.exists).toBe(false);
    expect(state.clean).toBe(false);
    expect(state.detail).toContain('does not exist');
  });

  it('reports clean + on main when repo is untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-a-'));
    try {
      initRepoOnMain(dir);
      const state = runSlotState(dir);
      expect(state.exists).toBe(true);
      expect(state.branch).toBe('main');
      expect(state.clean).toBe(true);
      expect(state.detail).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags uncommitted changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-b-'));
    try {
      initRepoOnMain(dir);
      writeFileSync(join(dir, 'scratch.txt'), 'dirty\n');
      const state = runSlotState(dir);
      expect(state.branch).toBe('main');
      expect(state.clean).toBe(false);
      expect(state.detail).toContain('uncommitted');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags being off main', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-c-'));
    try {
      initRepoOnMain(dir);
      execSync('git checkout -b claude/side', { cwd: dir, stdio: 'ignore' });
      const state = runSlotState(dir);
      expect(state.branch).toBe('claude/side');
      expect(state.clean).toBe(true); // tree is clean; branch is wrong
      expect(state.detail).toContain("on branch 'claude/side'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not flag unpushed as unclean when no upstream exists', () => {
    // Common case: a brand-new slot clone whose local `main` has never
    // been pushed to a remote — the `@{u}` rev parse fails, which we
    // treat as "no upstream, skip the un-pushed check."
    const dir = mkdtempSync(join(tmpdir(), 'ws-d-'));
    try {
      initRepoOnMain(dir);
      const state = runSlotState(dir);
      expect(state.clean).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runPreflight', () => {
  const okSlot = {
    slotDir: '/lw/a7',
    exists: true,
    branch: 'main',
    clean: true,
    detail: '',
  };

  it('returns ok when all three signals pass', async () => {
    const pf = await runPreflight('QUA-437', '/lw/a7', baseCtx, {
      findActiveClaimsByOthers: async () => [],
      findOpenPrsMentioningLinearId: async () => [],
      inspectSlot: () => okSlot,
    });
    expect(pf.ok).toBe(true);
    expect(pf.blockers).toEqual([]);
  });

  it('reports linear-claim blocker', async () => {
    const pf = await runPreflight('QUA-437', '/lw/a7', baseCtx, {
      findActiveClaimsByOthers: async () => [
        {
          body: '🤖 Claude Code starting work',
          createdAt: '2026-04-17T10:00:00Z',
          branch: null,
          slot: 'a9',
        },
      ],
      findOpenPrsMentioningLinearId: async () => [],
      inspectSlot: () => okSlot,
    });
    expect(pf.ok).toBe(false);
    expect(pf.blockers).toContain('linear-claim');
  });

  it('reports open-pr blocker independently of linear-claim', async () => {
    const pf = await runPreflight('QUA-437', '/lw/a7', baseCtx, {
      findActiveClaimsByOthers: async () => [],
      findOpenPrsMentioningLinearId: async () => [
        { number: 1, title: 't', url: 'u' },
      ],
      inspectSlot: () => okSlot,
    });
    expect(pf.blockers).toEqual(['open-pr']);
  });

  it('reports slot-off-main when branch is wrong', async () => {
    const pf = await runPreflight('QUA-437', '/lw/a7', baseCtx, {
      findActiveClaimsByOthers: async () => [],
      findOpenPrsMentioningLinearId: async () => [],
      inspectSlot: () => ({
        ...okSlot,
        branch: 'claude/other',
        detail: "on branch 'claude/other'",
      }),
    });
    expect(pf.blockers).toContain('slot-off-main');
  });

  it('reports slot-dirty when on main but dirty', async () => {
    const pf = await runPreflight('QUA-437', '/lw/a7', baseCtx, {
      findActiveClaimsByOthers: async () => [],
      findOpenPrsMentioningLinearId: async () => [],
      inspectSlot: () => ({
        ...okSlot,
        clean: false,
        detail: 'uncommitted changes: M scratch',
      }),
    });
    expect(pf.blockers).toContain('slot-dirty');
  });

  it('combines multiple blockers', async () => {
    const pf = await runPreflight('QUA-437', '/lw/a7', baseCtx, {
      findActiveClaimsByOthers: async () => [
        { body: 'x', createdAt: '2026-04-17T10:00:00Z', branch: null, slot: 'a9' },
      ],
      findOpenPrsMentioningLinearId: async () => [
        { number: 1, title: 't', url: 'u' },
      ],
      inspectSlot: () => ({ ...okSlot, clean: false, detail: 'dirty' }),
    });
    expect(pf.blockers).toContain('linear-claim');
    expect(pf.blockers).toContain('open-pr');
    expect(pf.blockers).toContain('slot-dirty');
  });
});
