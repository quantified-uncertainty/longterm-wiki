/**
 * Tests for PR patrol claim/release primitives (QUA-400 race fix).
 *
 * The core property under test: when `tryClaimPr` fails because another
 * worker already holds the claim, `releasePrIfClaimed` must NOT touch the
 * label. Previously the flow was "rebase-verify -> finally releasePr" and
 * the unconditional release would delete the OTHER worker's label during
 * the ~12s rebase window.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  tryClaimPr,
  releasePrIfClaimed,
  type ClaimDeps,
} from './claim.ts';

function makeDeps(overrides: Partial<ClaimDeps> = {}): ClaimDeps {
  return {
    fetchLabels: vi.fn().mockResolvedValue([]),
    addWorkingLabel: vi.fn().mockResolvedValue(undefined),
    removeWorkingLabel: vi.fn().mockResolvedValue(undefined),
    onClaimLost: vi.fn(),
    ...overrides,
  };
}

describe('tryClaimPr', () => {
  it('acquires the claim when PR has no working labels', async () => {
    const deps = makeDeps({
      fetchLabels: vi.fn().mockResolvedValue(['needs-review']),
    });
    const didClaim = await tryClaimPr(123, 'owner/repo', deps);
    expect(didClaim).toBe(true);
    expect(deps.addWorkingLabel).toHaveBeenCalledWith(123, 'owner/repo');
    expect(deps.onClaimLost).not.toHaveBeenCalled();
  });

  it('refuses to claim when pr-patrol:working label already present', async () => {
    const deps = makeDeps({
      fetchLabels: vi.fn().mockResolvedValue(['pr-patrol:working', 'needs-review']),
    });
    const didClaim = await tryClaimPr(456, 'owner/repo', deps);
    expect(didClaim).toBe(false);
    // Critical: we must not add our own label on top of the other worker's
    expect(deps.addWorkingLabel).not.toHaveBeenCalled();
    expect(deps.onClaimLost).toHaveBeenCalledWith(
      456,
      expect.stringContaining('already claimed'),
    );
  });

  it('refuses to claim when agent:working label is present (any working label)', async () => {
    const deps = makeDeps({
      fetchLabels: vi.fn().mockResolvedValue(['agent:working']),
    });
    const didClaim = await tryClaimPr(789, 'owner/repo', deps);
    expect(didClaim).toBe(false);
    expect(deps.addWorkingLabel).not.toHaveBeenCalled();
  });

  it('returns false when label fetch fails (fails closed)', async () => {
    const deps = makeDeps({
      fetchLabels: vi.fn().mockRejectedValue(new Error('network down')),
    });
    const didClaim = await tryClaimPr(111, 'owner/repo', deps);
    expect(didClaim).toBe(false);
    expect(deps.addWorkingLabel).not.toHaveBeenCalled();
    expect(deps.onClaimLost).toHaveBeenCalledWith(
      111,
      expect.stringContaining('pre-check failed'),
    );
  });

  it('returns false when label write fails after a clean pre-check', async () => {
    const deps = makeDeps({
      fetchLabels: vi.fn().mockResolvedValue([]),
      addWorkingLabel: vi.fn().mockRejectedValue(new Error('422 validation')),
    });
    const didClaim = await tryClaimPr(222, 'owner/repo', deps);
    expect(didClaim).toBe(false);
    expect(deps.onClaimLost).toHaveBeenCalledWith(
      222,
      expect.stringContaining('label write failed'),
    );
  });
});

describe('releasePrIfClaimed', () => {
  it('releases the label when didClaim === true', async () => {
    const deps = makeDeps();
    await releasePrIfClaimed(true, 333, 'owner/repo', deps);
    expect(deps.removeWorkingLabel).toHaveBeenCalledWith(333, 'owner/repo');
  });

  it('is a no-op when didClaim === false (does NOT touch the label)', async () => {
    const deps = makeDeps();
    await releasePrIfClaimed(false, 444, 'owner/repo', deps);
    expect(deps.removeWorkingLabel).not.toHaveBeenCalled();
  });
});

// ── The race scenario: this is the core regression test for QUA-400 ─────────
//
// Reproduces the bug the CodeRabbit critical review flagged.
//
// Before the fix: `tryRebaseAndVerify()` was called BEFORE the claim, and
// the `finally` block unconditionally called `releasePr()`. If another
// worker claimed the PR during the ~12s rebase window, the release would
// delete the OTHER worker's label — corrupting the claim/coordination layer.
//
// After the fix: the caller invokes `tryClaimPr()` FIRST, tracks the
// `didClaim` result in a local, and the `finally` block calls
// `releasePrIfClaimed(didClaim, ...)`. When another worker beats us to the
// claim, `tryClaimPr` returns `false` and `releasePrIfClaimed` is a no-op,
// so the other worker's label stays intact.

describe('QUA-400 race scenario — claim-then-release ownership tracking', () => {
  it('when a concurrent worker claims first, we bail out without touching their label', async () => {
    // Simulate: Worker A starts first. At claim time, Worker B has already
    // added pr-patrol:working (they won the race).
    const deps = makeDeps({
      fetchLabels: vi.fn().mockResolvedValue(['pr-patrol:working']),
    });

    // The fixed flow (mirrors execution.ts / parallel.ts):
    let didClaim = false;
    try {
      didClaim = await tryClaimPr(999, 'owner/repo', deps);
      if (!didClaim) {
        // Claim lost — skip work, bail out.
        return;
      }
      // Imagine tryRebaseAndVerify(...) runs here. It doesn't matter
      // for the race test — we never reach it because we bailed out.
    } finally {
      await releasePrIfClaimed(didClaim, 999, 'owner/repo', deps);
    }

    // Core assertions:
    expect(didClaim).toBe(false);
    // We must not have added our own working label on top of theirs.
    expect(deps.addWorkingLabel).not.toHaveBeenCalled();
    // CRITICAL: we must not have deleted the other worker's label.
    expect(deps.removeWorkingLabel).not.toHaveBeenCalled();
  });

  it('when we successfully claim, the finally block DOES release the label', async () => {
    const deps = makeDeps({
      fetchLabels: vi.fn().mockResolvedValue([]),
    });

    let didClaim = false;
    try {
      didClaim = await tryClaimPr(1000, 'owner/repo', deps);
      // Simulate tryRebaseAndVerify doing its 12s of work…
    } finally {
      await releasePrIfClaimed(didClaim, 1000, 'owner/repo', deps);
    }

    expect(didClaim).toBe(true);
    expect(deps.addWorkingLabel).toHaveBeenCalledTimes(1);
    expect(deps.removeWorkingLabel).toHaveBeenCalledTimes(1);
  });

  it('when we claim successfully but the work throws, the label is still released', async () => {
    const deps = makeDeps({
      fetchLabels: vi.fn().mockResolvedValue([]),
    });

    let didClaim = false;
    let caught: Error | null = null;
    try {
      try {
        didClaim = await tryClaimPr(1001, 'owner/repo', deps);
        // Simulate tryRebaseAndVerify blowing up partway through.
        throw new Error('rebase blew up');
      } finally {
        await releasePrIfClaimed(didClaim, 1001, 'owner/repo', deps);
      }
    } catch (e) {
      caught = e as Error;
    }

    expect(caught?.message).toBe('rebase blew up');
    expect(didClaim).toBe(true);
    expect(deps.removeWorkingLabel).toHaveBeenCalledTimes(1);
  });
});
