/**
 * Tests for PR patrol claim/release primitives (QUA-400 race fix).
 *
 * The core property under test: when `tryClaimPr` fails because another
 * worker already holds the claim, `releasePrIfClaimed` must NOT touch the
 * label. Previously the flow was "rebase-verify -> finally releasePr" and
 * the unconditional release would delete the OTHER worker's label during
 * the ~12s rebase window.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the github lib BEFORE importing the module under test, so the
// `defaultRemoveWorkingLabel` tests can inject fake 404/500 responses.
// The existing ClaimDeps-based tests don't touch githubApi at all, so
// the mock is transparent to them.
vi.mock('../lib/github.ts', async () => {
  const actual = await vi.importActual<typeof import('../lib/github.ts')>(
    '../lib/github.ts',
  );
  return {
    ...actual,
    githubApi: vi.fn(),
  };
});

import {
  tryClaimPr,
  releasePrIfClaimed,
  defaultRemoveWorkingLabel,
  type ClaimDeps,
} from './claim.ts';
import { githubApi, GitHubApiError } from '../lib/github.ts';

const mockGithubApi = vi.mocked(githubApi);

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

  it('returns false when label write fails and post-check confirms label absent', async () => {
    // The label-write POST really did fail — the server never applied the
    // label. Re-query succeeds and shows the label is still absent, so we
    // can safely report `didClaim=false`.
    const fetchLabels = vi
      .fn()
      .mockResolvedValueOnce([]) // pre-check: nothing
      .mockResolvedValueOnce(['needs-review']); // post-check: still no working label
    const deps = makeDeps({
      fetchLabels,
      addWorkingLabel: vi.fn().mockRejectedValue(new Error('422 validation')),
    });
    const didClaim = await tryClaimPr(222, 'owner/repo', deps);
    expect(didClaim).toBe(false);
    expect(deps.onClaimLost).toHaveBeenCalledWith(
      222,
      expect.stringContaining('label write failed'),
    );
    // Both the pre-check and the post-check fetches should have happened
    expect(fetchLabels).toHaveBeenCalledTimes(2);
  });

  // CodeRabbit QUA-400 Major finding: a POST can succeed server-side even
  // when the client sees a connection reset / timeout. Returning `false` in
  // that case would no-op the finally release and leak the label.
  it('returns true when label write throws but post-check shows label present', async () => {
    // The POST appeared to fail client-side, but the server actually
    // applied the label (e.g. connection reset after commit). The
    // post-write re-check catches this and upgrades didClaim to true.
    const fetchLabels = vi
      .fn()
      .mockResolvedValueOnce([]) // pre-check: unclaimed
      .mockResolvedValueOnce(['pr-patrol:working']); // post-check: label present
    const deps = makeDeps({
      fetchLabels,
      addWorkingLabel: vi
        .fn()
        .mockRejectedValue(new Error('socket hang up (ECONNRESET)')),
    });
    const didClaim = await tryClaimPr(333, 'owner/repo', deps);
    // Critical: we must return true so the finally-release cleans up the
    // label. Returning false would leak it permanently.
    expect(didClaim).toBe(true);
    expect(fetchLabels).toHaveBeenCalledTimes(2);
    // onClaimLost is used for observability in this path — the caller gets
    // a hint that the POST initially appeared to fail.
    expect(deps.onClaimLost).toHaveBeenCalledWith(
      333,
      expect.stringContaining('post-write re-check shows'),
    );
  });

  it('returns true (fail-safe) when both label write AND post-check fail', async () => {
    // Worst case: we can't tell whether the POST landed server-side. The
    // safe default is `didClaim=true` so the finally-release can clean up
    // any lingering label. A DELETE on an absent label is a harmless 404;
    // a missed release on a present label is a permanent leak.
    const fetchLabels = vi
      .fn()
      .mockResolvedValueOnce([]) // pre-check: unclaimed
      .mockRejectedValueOnce(new Error('network fully down')); // post-check fails
    const deps = makeDeps({
      fetchLabels,
      addWorkingLabel: vi.fn().mockRejectedValue(new Error('ETIMEDOUT')),
    });
    const didClaim = await tryClaimPr(444, 'owner/repo', deps);
    expect(didClaim).toBe(true);
    expect(fetchLabels).toHaveBeenCalledTimes(2);
    expect(deps.onClaimLost).toHaveBeenCalledWith(
      444,
      expect.stringContaining('fail-safe'),
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
    //
    // NOTE: do NOT `return` out of the try block on the `!didClaim` path.
    // An early return inside `try` short-circuits the post-try assertions
    // and makes the regression test vacuous — it would still pass even if
    // the `finally` block unconditionally called `removeWorkingLabel` on
    // another worker's label. Instead, gate the "real work" on
    // `didClaim === true` and let execution fall through to the finally
    // block AND the assertions below. (CodeRabbit QUA-400 follow-up.)
    let didClaim = false;
    try {
      didClaim = await tryClaimPr(999, 'owner/repo', deps);
      if (didClaim) {
        // Imagine tryRebaseAndVerify(...) runs here. We never reach it
        // in this scenario because another worker beat us to the claim,
        // but the caller code path must still fall through to the
        // finally + post-try assertions for the test to exercise the
        // `didClaim === false` release path.
      }
    } finally {
      await releasePrIfClaimed(didClaim, 999, 'owner/repo', deps);
    }

    // Core assertions — these MUST run (i.e. not be short-circuited by an
    // early return above) for the regression test to have teeth:
    expect(didClaim).toBe(false);
    // We must not have added our own working label on top of theirs.
    expect(deps.addWorkingLabel).not.toHaveBeenCalled();
    // CRITICAL: we must not have deleted the other worker's label.
    // This is the assertion that was previously unreachable because of
    // the early `return` inside the try block.
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

// ── defaultRemoveWorkingLabel — 404 discrimination (QUA-400 follow-up) ─────
//
// CodeRabbit Major finding: the previous implementation swallowed any
// error whose .message contained "404" or "Not Found", which also hides
// 500-class failures whose response body happens to mention those strings.
// The fix keys off the structured .status on GitHubApiError.
//
// These tests lock in:
//   - a real 404 is swallowed (label already absent is fine)
//   - a 500 is NOT swallowed, even if its body mentions "404" or "Not Found"
//   - a plain Error (non-GitHubApiError) is NOT swallowed

describe('defaultRemoveWorkingLabel — 404 discrimination', () => {
  beforeEach(() => {
    mockGithubApi.mockReset();
  });

  it('swallows a concrete HTTP 404 (label already absent)', async () => {
    mockGithubApi.mockRejectedValueOnce(
      new GitHubApiError(
        'DELETE',
        '/repos/owner/repo/issues/42/labels/pr-patrol%3Aworking',
        404,
        '{"message":"Label does not exist"}',
      ),
    );

    // Must NOT throw.
    await expect(
      defaultRemoveWorkingLabel(42, 'owner/repo'),
    ).resolves.toBeUndefined();
    expect(mockGithubApi).toHaveBeenCalledTimes(1);
  });

  it('re-throws a 500 even when the body text contains "404"', async () => {
    // The key regression scenario: a 500 response body that happens to
    // mention "404" (e.g. because the upstream stack trace referenced a
    // 404 log line, or the error message says "upstream returned 404").
    // Under the old substring-match implementation this would be
    // silently swallowed; under the .status check it must bubble.
    const err = new GitHubApiError(
      'DELETE',
      '/repos/owner/repo/issues/42/labels/pr-patrol%3Aworking',
      500,
      '{"message":"upstream reported 404 in logs"}',
    );
    mockGithubApi.mockRejectedValueOnce(err);

    // Call once, assert on the rejection shape.
    let caught: unknown;
    try {
      await defaultRemoveWorkingLabel(42, 'owner/repo');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GitHubApiError);
    expect(caught).toMatchObject({ status: 500 });
    expect((caught as GitHubApiError).message).toContain('404');
  });

  it('re-throws a 500 even when the body text contains "Not Found"', async () => {
    mockGithubApi.mockRejectedValueOnce(
      new GitHubApiError(
        'DELETE',
        '/repos/owner/repo/issues/42/labels/pr-patrol%3Aworking',
        500,
        '{"message":"Internal: cached entry Not Found"}',
      ),
    );

    await expect(
      defaultRemoveWorkingLabel(42, 'owner/repo'),
    ).rejects.toMatchObject({ status: 500 });
  });

  it('re-throws a 403 (permission denied — label stays stuck, not a benign case)', async () => {
    mockGithubApi.mockRejectedValueOnce(
      new GitHubApiError(
        'DELETE',
        '/repos/owner/repo/issues/42/labels/pr-patrol%3Aworking',
        403,
        '{"message":"Resource not accessible by integration"}',
      ),
    );

    await expect(
      defaultRemoveWorkingLabel(42, 'owner/repo'),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('re-throws a plain Error (non-GitHubApiError, e.g. network failure)', async () => {
    // A pre-HTTP failure (fetch abort, DNS error, etc.) reaches us as a
    // plain Error — not a GitHubApiError. We must bubble it so callers
    // can see the network is broken.
    mockGithubApi.mockRejectedValueOnce(new Error('fetch failed: ECONNRESET'));

    await expect(
      defaultRemoveWorkingLabel(42, 'owner/repo'),
    ).rejects.toThrow('fetch failed: ECONNRESET');
  });

  it('returns normally on a successful 204 No Content', async () => {
    // githubApi returns undefined on 204.
    mockGithubApi.mockResolvedValueOnce(undefined);

    await expect(
      defaultRemoveWorkingLabel(42, 'owner/repo'),
    ).resolves.toBeUndefined();
    expect(mockGithubApi).toHaveBeenCalledWith(
      expect.stringContaining('/repos/owner/repo/issues/42/labels/'),
      { method: 'DELETE' },
    );
  });
});
