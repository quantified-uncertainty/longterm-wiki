/**
 * Tests for `crux sys dispatch` — QUA-437.
 *
 * Covers the three pre-flight signals (Linear claim, open PR, target
 * slot) and the --force / --dry-run / --reason combinations. All
 * external surfaces (Linear, GitHub, tmux, git) are mocked via
 * dependency injection rather than vi.mock so the tests stay close to
 * the handler's real code paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dispatchDefault, buildForceClaimComment } from '../dispatch.ts';
import type { DispatchDeps } from '../dispatch.ts';
import type { PreflightResult, SlotStateCheck } from '../../lib/dispatch/preflight.ts';
import type { DispatchLogEntry } from '../../lib/dispatch/audit-log.ts';

/**
 * vi.fn() infers tighter signatures from 2-arg lambdas than DispatchDeps
 * wants (4 params for runPreflight, 1 param for getIssue). Typing the
 * override bag as Record<string, unknown> and casting at the spread site
 * keeps tests terse without weakening the production type.
 */
type TestDispatchOverrides = Record<string, unknown>;

function cleanSlot(slotDir = '/lw/a7'): SlotStateCheck {
  return { slotDir, exists: true, branch: 'main', clean: true, detail: '' };
}

function makeDeps(overrides: TestDispatchOverrides = {}): {
  deps: DispatchDeps;
  spies: {
    openSlot: ReturnType<typeof vi.fn>;
    appendDispatchLog: ReturnType<typeof vi.fn>;
    commentOnIssue: ReturnType<typeof vi.fn>;
    getIssue: ReturnType<typeof vi.fn>;
    runPreflight: ReturnType<typeof vi.fn>;
  };
} {
  const openSlot = vi.fn(() => ({ ok: true }));
  const appendDispatchLog = vi.fn();
  const commentOnIssue = vi.fn(async () => {});
  const getIssue = vi.fn(async () => ({
    id: 'uuid-437',
    identifier: 'QUA-437',
    title: 'Test',
    description: null,
    priority: 2,
    url: 'https://linear.app/quantifieduncertainty/issue/QUA-437',
    state: { id: 's', name: 'In Progress', type: 'started' },
    team: { id: 't', key: 'QUA' },
    parent: null,
    project: null,
    labels: { nodes: [] },
    children: { nodes: [] },
  }));
  const runPreflight = vi.fn(
    async (_id: string, slotDir: string): Promise<PreflightResult> => ({
      linearClaims: [],
      openPrs: [],
      slot: cleanSlot(slotDir),
      ok: true,
      blockers: [],
    }),
  );

  const deps = {
    getIssue,
    commentOnIssue,
    getSessionContext: () => ({
      slot: 10,
      branch: 'claude/qua-437-sys-dispatch-wrapper',
      host: 'test-host',
      agentId: null,
    }),
    runPreflight,
    appendDispatchLog,
    openSlot,
    resolveLwDir: () => '/lw',
    ...overrides,
  } as unknown as DispatchDeps;
  return {
    deps,
    spies: { openSlot, appendDispatchLog, commentOnIssue, getIssue, runPreflight },
  };
}

beforeEach(() => {
  // Ensure TMUX check in the open branch doesn't flake between tests.
  process.env.TMUX = 'test-tmux';
});

describe('crux sys dispatch — argument validation', () => {
  it('errors when --linear is missing', async () => {
    const { deps } = makeDeps();
    const r = await dispatchDefault([], { slot: '7', ci: true }, deps);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('Usage: crux sys dispatch');
  });

  it('errors when --slot is missing', async () => {
    const { deps } = makeDeps();
    const r = await dispatchDefault([], { linear: 'QUA-437', ci: true }, deps);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('--slot=<N> is required');
  });

  it('errors when --slot is not a positive integer', async () => {
    const { deps } = makeDeps();
    const r = await dispatchDefault([], { linear: 'QUA-437', slot: 'abc', ci: true }, deps);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('positive integer');
  });

  it('errors when --force is set without --reason', async () => {
    const { deps } = makeDeps();
    const r = await dispatchDefault(
      [],
      { linear: 'QUA-437', slot: '7', force: true, ci: true },
      deps,
    );
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('requires --reason');
  });

  it('errors when the Linear issue is not found', async () => {
    const { deps } = makeDeps({ getIssue: vi.fn(async () => null) });
    const r = await dispatchDefault(
      [],
      { linear: 'QUA-99999', slot: '7', dryRun: true, ci: true },
      deps,
    );
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('not found');
  });
});

describe('crux sys dispatch — pre-flight blocking', () => {
  it('refuses with exit 2 when a Linear claim exists', async () => {
    const { deps, spies } = makeDeps({
      runPreflight: vi.fn(async (_id: string, _dir: string) => ({
        linearClaims: [
          {
            body: '🤖 Claude Code starting work\n**Slot:** a9\n**Branch:** `claude/qua-437-other`',
            createdAt: '2026-04-17T10:00:00Z',
            branch: 'claude/qua-437-other',
            slot: 'a9',
          },
        ],
        openPrs: [],
        slot: cleanSlot(),
        ok: false,
        blockers: ['linear-claim'],
      })),
    });

    const r = await dispatchDefault(
      [],
      { linear: 'QUA-437', slot: '7', dryRun: true, ci: true },
      deps,
    );
    expect(r.exitCode).toBe(2);
    expect(r.output).toContain('Pre-flight blocked');
    expect(r.output).toContain('Active Linear claim');
    expect(r.output).toContain('a9');
    expect(spies.openSlot).not.toHaveBeenCalled();
    expect(spies.appendDispatchLog).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'refused', blockers: ['linear-claim'] }),
    );
  });

  it('refuses when an open PR references the ticket', async () => {
    const { deps, spies } = makeDeps({
      runPreflight: vi.fn(async (_id: string, _dir: string) => ({
        linearClaims: [],
        openPrs: [
          {
            number: 4297,
            title: 'QUA-397: fix things',
            url: 'https://github.com/quantified-uncertainty/longterm-wiki/pull/4297',
          },
        ],
        slot: cleanSlot(),
        ok: false,
        blockers: ['open-pr'],
      })),
    });

    const r = await dispatchDefault(
      [],
      { linear: 'QUA-397', slot: '7', ci: true },
      deps,
    );
    expect(r.exitCode).toBe(2);
    expect(r.output).toContain('Open PR');
    expect(r.output).toContain('#4297');
    expect(spies.openSlot).not.toHaveBeenCalled();
  });

  it('refuses when target slot is on a feature branch', async () => {
    const { deps } = makeDeps({
      runPreflight: vi.fn(async (_id: string, _dir: string) => ({
        linearClaims: [],
        openPrs: [],
        slot: {
          slotDir: '/lw/a7',
          exists: true,
          branch: 'claude/qua-111-foo',
          clean: false,
          detail: "on branch 'claude/qua-111-foo' (expected 'main')",
        },
        ok: false,
        blockers: ['slot-off-main'],
      })),
    });

    const r = await dispatchDefault(
      [],
      { linear: 'QUA-437', slot: '7', ci: true },
      deps,
    );
    expect(r.exitCode).toBe(2);
    expect(r.output).toContain('Target slot');
    expect(r.output).toContain("'claude/qua-111-foo'");
  });

  it('refuses when target slot does not exist', async () => {
    const { deps } = makeDeps({
      runPreflight: vi.fn(async (_id: string, _dir: string) => ({
        linearClaims: [],
        openPrs: [],
        slot: {
          slotDir: '/lw/a99',
          exists: false,
          branch: '',
          clean: false,
          detail: 'slot directory does not exist',
        },
        ok: false,
        blockers: ['slot-missing'],
      })),
    });

    const r = await dispatchDefault(
      [],
      { linear: 'QUA-437', slot: '99', ci: true },
      deps,
    );
    expect(r.exitCode).toBe(2);
    expect(r.output).toContain('does not exist');
  });
});

describe('crux sys dispatch — --force override', () => {
  it('dispatches past a Linear claim with --force + --reason', async () => {
    const { deps, spies } = makeDeps({
      runPreflight: vi.fn(async (_id: string, _dir: string) => ({
        linearClaims: [
          {
            body: '🤖 Claude Code starting work\n**Slot:** a9',
            createdAt: '2026-04-17T10:00:00Z',
            branch: null,
            slot: 'a9',
          },
        ],
        openPrs: [],
        slot: cleanSlot(),
        ok: false,
        blockers: ['linear-claim'],
      })),
    });

    const r = await dispatchDefault(
      [],
      {
        linear: 'QUA-437',
        slot: '7',
        force: true,
        reason: 'slot a9 abandoned, confirmed with user',
        ci: true,
      },
      deps,
    );
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('Forced past pre-flight');
    expect(spies.openSlot).toHaveBeenCalledWith(7, '/lw');
    expect(spies.commentOnIssue).toHaveBeenCalledTimes(1);
    const commentBody = spies.commentOnIssue.mock.calls[0][1];
    expect(commentBody).toContain('⚠ Claim forced via');
    expect(commentBody).toContain('slot a9 abandoned, confirmed with user');
    expect(spies.appendDispatchLog).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'forced',
        force: true,
        forceReason: 'slot a9 abandoned, confirmed with user',
      }),
    );
  });

  it('does not post a Linear comment in dry-run even when --force is set', async () => {
    const { deps, spies } = makeDeps({
      runPreflight: vi.fn(async (_id: string, _dir: string) => ({
        linearClaims: [
          { body: 'x', createdAt: '2026-04-17T10:00:00Z', branch: null, slot: 'a9' },
        ],
        openPrs: [],
        slot: cleanSlot(),
        ok: false,
        blockers: ['linear-claim'],
      })),
    });

    const r = await dispatchDefault(
      [],
      {
        linear: 'QUA-437',
        slot: '7',
        force: true,
        reason: 'checking',
        dryRun: true,
        ci: true,
      },
      deps,
    );
    expect(r.exitCode).toBe(0);
    expect(spies.commentOnIssue).not.toHaveBeenCalled();
    expect(spies.openSlot).not.toHaveBeenCalled();
    expect(spies.appendDispatchLog).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'dry-run', force: true }),
    );
  });

  it('proceeds when Linear comment posting fails (best-effort)', async () => {
    const { deps, spies } = makeDeps({
      commentOnIssue: vi.fn(async () => {
        throw new Error('Linear down');
      }),
      runPreflight: vi.fn(async (_id: string, _dir: string) => ({
        linearClaims: [
          { body: 'x', createdAt: '2026-04-17T10:00:00Z', branch: null, slot: 'a9' },
        ],
        openPrs: [],
        slot: cleanSlot(),
        ok: false,
        blockers: ['linear-claim'],
      })),
    });

    const r = await dispatchDefault(
      [],
      {
        linear: 'QUA-437',
        slot: '7',
        force: true,
        reason: 'API is down, prod hotfix',
        ci: true,
      },
      deps,
    );
    expect(r.exitCode).toBe(0);
    expect(spies.openSlot).toHaveBeenCalledTimes(1);
  });
});

describe('crux sys dispatch — happy path', () => {
  it('dispatches when pre-flight passes', async () => {
    const { deps, spies } = makeDeps();
    const r = await dispatchDefault(
      [],
      { linear: 'QUA-437', slot: '7', ci: true },
      deps,
    );
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('Dispatched QUA-437');
    expect(spies.openSlot).toHaveBeenCalledWith(7, '/lw');
    expect(spies.commentOnIssue).not.toHaveBeenCalled();
    expect(spies.appendDispatchLog).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'dispatched',
        force: false,
        blockers: [],
      }),
    );
  });

  it('dry-run succeeds without opening the slot', async () => {
    const { deps, spies } = makeDeps();
    const r = await dispatchDefault(
      [],
      { linear: 'QUA-437', slot: '7', dryRun: true, ci: true },
      deps,
    );
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('Pre-flight passed');
    expect(r.output).toContain('dry-run');
    expect(spies.openSlot).not.toHaveBeenCalled();
    expect(spies.appendDispatchLog).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'dry-run' }),
    );
  });

  it('errors when not in a tmux session (not a dry-run)', async () => {
    const { deps, spies } = makeDeps();
    delete process.env.TMUX;
    const r = await dispatchDefault(
      [],
      { linear: 'QUA-437', slot: '7', ci: true },
      deps,
    );
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('not inside a tmux session');
    expect(spies.openSlot).not.toHaveBeenCalled();
  });

  it('propagates ./ws open failures as exit 1', async () => {
    const { deps, spies } = makeDeps({
      openSlot: vi.fn(() => ({ ok: false, error: 'tmux refused' })),
    });
    const r = await dispatchDefault(
      [],
      { linear: 'QUA-437', slot: '7', ci: true },
      deps,
    );
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('tmux refused');
    // We still log the attempt so operators can see the open failed.
    const logged: DispatchLogEntry = spies.appendDispatchLog.mock.calls[0][0];
    expect(logged.blockers).toContain('open-failed');
  });
});

describe('buildForceClaimComment', () => {
  it('includes slot + reason + reconciliation guidance', () => {
    const body = buildForceClaimComment({
      dispatcherSlot: 10,
      dispatcherBranch: 'claude/qua-437-wrap',
      targetSlot: 7,
      reason: 'prior session abandoned, tmux dead',
    });
    expect(body).toContain('⚠ Claim forced via');
    expect(body).toContain('slot a10');
    expect(body).toContain('slot a7');
    expect(body).toContain('prior session abandoned, tmux dead');
    expect(body).toContain('agent-checklist init --force');
  });

  it('falls back to branch tag when dispatcher slot is null', () => {
    const body = buildForceClaimComment({
      dispatcherSlot: null,
      dispatcherBranch: 'main',
      targetSlot: 3,
      reason: 'r',
    });
    // Dispatcher is identified by branch, not slot
    expect(body).toContain('from branch `main`');
    expect(body).not.toMatch(/from slot a\d/);
    // Target slot still renders as "slot a<N>"
    expect(body).toContain('slot a3');
  });
});
