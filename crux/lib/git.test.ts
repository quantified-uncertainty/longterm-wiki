import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'child_process';
import { isValidBranchName, syncToMain } from './git.ts';

const mockExecFileSync = vi.mocked(execFileSync);

describe('isValidBranchName', () => {
  it('accepts typical branch names', () => {
    expect(isValidBranchName('main')).toBe(true);
    expect(isValidBranchName('feature/add-login')).toBe(true);
    expect(isValidBranchName('claude/kind-jepsen')).toBe(true);
    expect(isValidBranchName('auto-update/2026-03-04')).toBe(true);
    expect(isValidBranchName('fix_underscore')).toBe(true);
    expect(isValidBranchName('v1.2.3')).toBe(true);
  });

  it('rejects empty and overly long names', () => {
    expect(isValidBranchName('')).toBe(false);
    expect(isValidBranchName('a'.repeat(256))).toBe(false);
  });

  it('rejects names with shell-dangerous characters', () => {
    expect(isValidBranchName('branch; rm -rf /')).toBe(false);
    expect(isValidBranchName('branch$(whoami)')).toBe(false);
    expect(isValidBranchName('branch`id`')).toBe(false);
    expect(isValidBranchName('branch|cat')).toBe(false);
    expect(isValidBranchName('branch name with spaces')).toBe(false);
    expect(isValidBranchName("branch'quote")).toBe(false);
    expect(isValidBranchName('branch"quote')).toBe(false);
  });

  it('accepts names at the boundary length', () => {
    expect(isValidBranchName('a'.repeat(255))).toBe(true);
  });
});

// ── syncToMain ───────────────────────────────────────────────────────────────
//
// `syncToMain` orchestrates: rev-parse (current branch) → status → checkout? → pull.
// Tests stub execFileSync per call to simulate each git invocation in order.

/** Stub a sequence of git invocations. Each entry maps to one execFileSync call. */
function stubGitCalls(
  calls: Array<
    | { ok: true; stdout: string }
    | { ok: false; stderr: string; stdout?: string; status?: number }
  >,
) {
  let i = 0;
  mockExecFileSync.mockImplementation(((..._args: unknown[]) => {
    const call = calls[i++];
    if (!call) throw new Error(`syncToMain made more git calls than stubbed (${i})`);
    if (call.ok) return call.stdout;
    const err = new Error(call.stderr) as Error & {
      status: number;
      stdout: string;
      stderr: string;
    };
    err.status = call.status ?? 1;
    err.stdout = call.stdout ?? '';
    err.stderr = call.stderr;
    throw err;
  }) as unknown as typeof execFileSync);
}

describe('syncToMain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('succeeds when already on main and pull is up to date', () => {
    stubGitCalls([
      { ok: true, stdout: 'main' },              // rev-parse --abbrev-ref HEAD
      { ok: true, stdout: '' },                  // status --porcelain (clean)
      { ok: true, stdout: 'Already up to date.' }, // pull --ff-only origin main
    ]);

    const result = syncToMain();
    expect(result.ok).toBe(true);
    expect(result.startBranch).toBe('main');
    expect(result.switchedBranch).toBe(false);
    expect(result.steps).toEqual([
      'Already on main',
      'Pulled main (already up to date)',
    ]);
  });

  it('checks out main and pulls when starting on a feature branch', () => {
    stubGitCalls([
      { ok: true, stdout: 'claude/feature-x' }, // rev-parse
      { ok: true, stdout: '' },                 // status
      { ok: true, stdout: "Switched to branch 'main'" }, // checkout main
      { ok: true, stdout: 'Updating abc..def\nFast-forward\n 1 file changed' }, // pull
    ]);

    const result = syncToMain();
    expect(result.ok).toBe(true);
    expect(result.startBranch).toBe('claude/feature-x');
    expect(result.switchedBranch).toBe(true);
    expect(result.steps[0]).toBe('Switched claude/feature-x → main');
    expect(result.steps[1]).toMatch(/^Pulled main/);
  });

  it('aborts when working tree has uncommitted changes', () => {
    stubGitCalls([
      { ok: true, stdout: 'main' },
      { ok: true, stdout: ' M apps/web/foo.tsx\n?? new-file.md' }, // dirty
    ]);

    const result = syncToMain();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Working tree is not clean');
    expect(result.error).toContain('apps/web/foo.tsx');
    expect(result.switchedBranch).toBe(false);
    // Should NOT have called checkout or pull.
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
  });

  it('aborts when checkout main fails', () => {
    stubGitCalls([
      { ok: true, stdout: 'claude/feature-x' },
      { ok: true, stdout: '' },
      { ok: false, stderr: 'error: branch main not found' },
    ]);

    const result = syncToMain();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('git checkout main failed');
    expect(result.error).toContain('branch main not found');
    expect(result.switchedBranch).toBe(false);
  });

  it('aborts when pull is non-fast-forward', () => {
    stubGitCalls([
      { ok: true, stdout: 'main' },
      { ok: true, stdout: '' },
      {
        ok: false,
        stderr: 'fatal: Not possible to fast-forward, aborting.',
      },
    ]);

    const result = syncToMain();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('git pull --ff-only origin main failed');
    expect(result.error).toContain('fast-forward');
  });
});
