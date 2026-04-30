import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

import {
  MAIN_BRANCH_COOLDOWN_SECONDS,
  MAIN_BRANCH_ABANDON_THRESHOLD,
  isMainBranchAbandoned,
  isAbandoned,
  recordFailure,
  resetFailCount,
  trackMainFixPr,
  getTrackedMainFixPr,
  clearTrackedMainFixPr,
  clearProcessed,
  ensureDirs,
  markProcessed,
  isRecentlyProcessed,
  getCodeRabbitRetryTime,
  setCodeRabbitRetryTime,
  clearCodeRabbitRetryTime,
  CODERABBIT_DEFAULT_RETRY_DELAY_MS,
  getProcessedBlockingCommentIds,
  markBlockingCommentsProcessed,
  clearProcessedBlockingComments,
  markAutoMergeDisabled,
  isAutoMergeDisabled,
  clearAutoMergeDisabled,
  AUTO_MERGE_DISABLED_COOLDOWN_SECONDS,
  REPO_AUTO_MERGE_DISABLED_ERROR_FRAGMENT,
  STATE_DIR,
} from './state.ts';

// Ensure the state directory exists before any tests write to it.
// On CI, ~/.cache/pr-patrol/state/ doesn't exist by default.
beforeAll(() => {
  ensureDirs();
});

// ── Constants ───────────────────────────────────────────────────────────────

describe('main branch constants', () => {
  it('has 5-minute cooldown for main branch', () => {
    expect(MAIN_BRANCH_COOLDOWN_SECONDS).toBe(300);
  });

  it('has higher abandonment threshold for main branch', () => {
    expect(MAIN_BRANCH_ABANDON_THRESHOLD).toBe(4);
    // Must be higher than the default PR threshold (2)
    expect(MAIN_BRANCH_ABANDON_THRESHOLD).toBeGreaterThan(2);
  });
});

// ── isMainBranchAbandoned ───────────────────────────────────────────────────

describe('isMainBranchAbandoned', () => {
  const testKey = `test-main-abandoned-${Date.now()}`;

  afterEach(() => {
    // Clean up test state files
    const file = join(STATE_DIR, `failures-${testKey}`);
    if (existsSync(file)) rmSync(file);
  });

  it('returns false when no failures recorded', () => {
    expect(isMainBranchAbandoned(testKey)).toBe(false);
  });

  it('returns false when failures below threshold', () => {
    writeFileSync(join(STATE_DIR, `failures-${testKey}`), '3');
    expect(isMainBranchAbandoned(testKey)).toBe(false);
  });

  it('returns true when failures reach threshold', () => {
    writeFileSync(join(STATE_DIR, `failures-${testKey}`), String(MAIN_BRANCH_ABANDON_THRESHOLD));
    expect(isMainBranchAbandoned(testKey)).toBe(true);
  });

  it('returns true when failures exceed threshold', () => {
    writeFileSync(join(STATE_DIR, `failures-${testKey}`), String(MAIN_BRANCH_ABANDON_THRESHOLD + 1));
    expect(isMainBranchAbandoned(testKey)).toBe(true);
  });
});

// ── Tracked main fix PR ─────────────────────────────────────────────────────

describe('tracked main fix PR', () => {
  afterEach(() => {
    clearTrackedMainFixPr();
  });

  it('returns null when no fix PR is tracked', () => {
    clearTrackedMainFixPr();
    expect(getTrackedMainFixPr()).toBeNull();
  });

  it('tracks and retrieves a fix PR', () => {
    trackMainFixPr(1875);
    const tracked = getTrackedMainFixPr();
    expect(tracked).not.toBeNull();
    expect(tracked!.prNumber).toBe(1875);
    expect(tracked!.createdAt).toBeTruthy();
    // Verify it's a valid ISO timestamp
    expect(new Date(tracked!.createdAt).toISOString()).toBe(tracked!.createdAt);
  });

  it('overwrites previous tracked PR', () => {
    trackMainFixPr(100);
    trackMainFixPr(200);
    const tracked = getTrackedMainFixPr();
    expect(tracked!.prNumber).toBe(200);
  });

  it('clear removes the tracked PR', () => {
    trackMainFixPr(1875);
    expect(getTrackedMainFixPr()).not.toBeNull();
    clearTrackedMainFixPr();
    expect(getTrackedMainFixPr()).toBeNull();
  });
});

// ── isAbandoned (PR failure tracking) ────────────────────────────────────────

describe('isAbandoned', () => {
  const testKey = `test-abandoned-${Date.now()}`;

  afterEach(() => {
    const file = join(STATE_DIR, `failures-${testKey}`);
    if (existsSync(file)) rmSync(file);
  });

  it('returns false with no failures', () => {
    expect(isAbandoned(testKey)).toBe(false);
  });

  it('returns false after 1 failure', () => {
    recordFailure(testKey);
    expect(isAbandoned(testKey)).toBe(false);
  });

  it('returns true after 2 failures (threshold)', () => {
    recordFailure(testKey);
    recordFailure(testKey);
    expect(isAbandoned(testKey)).toBe(true);
  });

  it('resets to non-abandoned after resetFailCount', () => {
    recordFailure(testKey);
    recordFailure(testKey);
    expect(isAbandoned(testKey)).toBe(true);
    resetFailCount(testKey);
    expect(isAbandoned(testKey)).toBe(false);
  });
});

// ── clearProcessed ──────────────────────────────────────────────────────────

describe('clearProcessed', () => {
  const testKey = `test-clear-${Date.now()}`;

  afterEach(() => {
    const file = join(STATE_DIR, `processed-${testKey}`);
    if (existsSync(file)) rmSync(file);
  });

  it('clears a processed timestamp so the key is no longer recently processed', () => {
    markProcessed(testKey);
    expect(isRecentlyProcessed(testKey, 3600)).toBe(true);
    clearProcessed(testKey);
    expect(isRecentlyProcessed(testKey, 3600)).toBe(false);
  });

  it('is safe to call when no processed file exists', () => {
    // Should not throw
    clearProcessed(`nonexistent-key-${Date.now()}`);
  });
});

// ── CodeRabbit retry tracking ────────────────────────────────────────────────

describe('CodeRabbit retry state', () => {
  const testPrNumber = 99990 + Math.floor(Math.random() * 1000);

  afterEach(() => {
    clearCodeRabbitRetryTime(testPrNumber);
  });

  it('returns null when no retry is scheduled', () => {
    expect(getCodeRabbitRetryTime(testPrNumber)).toBeNull();
  });

  it('stores and retrieves a retry timestamp', () => {
    const ts = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    setCodeRabbitRetryTime(testPrNumber, ts);
    expect(getCodeRabbitRetryTime(testPrNumber)).toBe(ts);
  });

  it('clears the retry timestamp', () => {
    const ts = new Date().toISOString();
    setCodeRabbitRetryTime(testPrNumber, ts);
    expect(getCodeRabbitRetryTime(testPrNumber)).not.toBeNull();
    clearCodeRabbitRetryTime(testPrNumber);
    expect(getCodeRabbitRetryTime(testPrNumber)).toBeNull();
  });

  it('clear is safe when no retry file exists', () => {
    // Should not throw
    clearCodeRabbitRetryTime(testPrNumber + 1);
  });

  it('has a 30-minute default retry delay', () => {
    expect(CODERABBIT_DEFAULT_RETRY_DELAY_MS).toBe(30 * 60 * 1000);
  });
});

// ── Processed blocking comments (QUA-514) ───────────────────────────────────

describe('processed blocking comments (QUA-514)', () => {
  const testPrNumber = 90000 + Math.floor(Math.random() * 10_000);
  const shaA = 'a'.repeat(40);
  const shaB = 'b'.repeat(40);

  afterEach(() => {
    clearProcessedBlockingComments(testPrNumber);
  });

  it('returns empty set when no cache file exists', () => {
    const ids = getProcessedBlockingCommentIds(testPrNumber, shaA);
    expect(ids.size).toBe(0);
  });

  it('persists and retrieves ids for matching SHA', () => {
    markBlockingCommentsProcessed(testPrNumber, shaA, ['IC_a', 'IC_b']);
    const ids = getProcessedBlockingCommentIds(testPrNumber, shaA);
    expect(ids.has('IC_a')).toBe(true);
    expect(ids.has('IC_b')).toBe(true);
    expect(ids.size).toBe(2);
  });

  it('returns empty set when stored SHA differs (force-push invalidates cache)', () => {
    markBlockingCommentsProcessed(testPrNumber, shaA, ['IC_a']);
    // Caller is on a different SHA now — must not see old ids.
    const ids = getProcessedBlockingCommentIds(testPrNumber, shaB);
    expect(ids.size).toBe(0);
  });

  it('overwrites cache when marking ids under a different SHA', () => {
    markBlockingCommentsProcessed(testPrNumber, shaA, ['IC_old']);
    markBlockingCommentsProcessed(testPrNumber, shaB, ['IC_new']);
    // Old SHA entries are gone; new SHA has only IC_new.
    expect(getProcessedBlockingCommentIds(testPrNumber, shaA).size).toBe(0);
    const newIds = getProcessedBlockingCommentIds(testPrNumber, shaB);
    expect(newIds.has('IC_new')).toBe(true);
    expect(newIds.has('IC_old')).toBe(false);
    expect(newIds.size).toBe(1);
  });

  it('unions new ids with existing ids under the same SHA', () => {
    markBlockingCommentsProcessed(testPrNumber, shaA, ['IC_a']);
    markBlockingCommentsProcessed(testPrNumber, shaA, ['IC_b', 'IC_a']); // IC_a duplicate
    const ids = getProcessedBlockingCommentIds(testPrNumber, shaA);
    expect(ids.size).toBe(2);
    expect(ids.has('IC_a')).toBe(true);
    expect(ids.has('IC_b')).toBe(true);
  });

  it('clear removes the cache file', () => {
    markBlockingCommentsProcessed(testPrNumber, shaA, ['IC_a']);
    clearProcessedBlockingComments(testPrNumber);
    const ids = getProcessedBlockingCommentIds(testPrNumber, shaA);
    expect(ids.size).toBe(0);
  });

  it('clear is safe when no cache file exists', () => {
    // Should not throw on a PR number with no state.
    clearProcessedBlockingComments(testPrNumber + 77);
  });

  it('empty newIds on a fresh cache is a no-op', () => {
    // Without an existing file, marking zero ids should not create one —
    // avoids littering STATE_DIR with empty files during cold-path scans.
    markBlockingCommentsProcessed(testPrNumber, shaA, []);
    const file = join(STATE_DIR, `processed-comments-${testPrNumber}.json`);
    expect(existsSync(file)).toBe(false);
  });

  it('tolerates corrupt cache file (returns empty)', () => {
    const file = join(STATE_DIR, `processed-comments-${testPrNumber}.json`);
    writeFileSync(file, 'not valid json{{{');
    const ids = getProcessedBlockingCommentIds(testPrNumber, shaA);
    expect(ids.size).toBe(0);
  });
});

// ── Auto-merge disabled circuit breaker (QUA-858) ──────────────────────────

describe('auto-merge disabled circuit breaker', () => {
  const STATE_FILE = join(STATE_DIR, 'auto-merge-disabled');

  afterEach(() => {
    clearAutoMergeDisabled();
  });

  it('exposes the GitHub error fragment used for detection', () => {
    expect(REPO_AUTO_MERGE_DISABLED_ERROR_FRAGMENT).toBe(
      'Auto merge is not allowed for this repository',
    );
  });

  it('uses a 1-hour cooldown', () => {
    expect(AUTO_MERGE_DISABLED_COOLDOWN_SECONDS).toBe(3600);
  });

  it('isAutoMergeDisabled() returns disabled:false when no state exists', () => {
    expect(isAutoMergeDisabled()).toEqual({ disabled: false });
  });

  it('markAutoMergeDisabled() persists reason and timestamp', () => {
    markAutoMergeDisabled('GitHub GraphQL error: Auto merge is not allowed for this repository');
    const status = isAutoMergeDisabled();
    expect(status.disabled).toBe(true);
    if (!status.disabled) throw new Error('expected disabled');
    expect(status.reason).toContain('Auto merge is not allowed');
    expect(typeof status.disabledAt).toBe('string');
    expect(new Date(status.disabledAt).toString()).not.toBe('Invalid Date');
  });

  it('markAutoMergeDisabled() is idempotent — preserves the original reason and timestamp on re-mark', () => {
    markAutoMergeDisabled('reason A');
    const first = isAutoMergeDisabled();
    if (!first.disabled) throw new Error('expected disabled after first mark');
    const firstAt = first.disabledAt;

    // A second mark with a different reason should NOT overwrite — the
    // existing file stays in place so the original disabledAt is preserved.
    markAutoMergeDisabled('reason B');
    const second = isAutoMergeDisabled();
    if (!second.disabled) throw new Error('expected disabled after second mark');
    expect(second.disabledAt).toBe(firstAt);
    expect(second.reason).toContain('reason A');
  });

  it('clearAutoMergeDisabled() removes the state file', () => {
    markAutoMergeDisabled('test');
    expect(isAutoMergeDisabled().disabled).toBe(true);
    clearAutoMergeDisabled();
    expect(isAutoMergeDisabled()).toEqual({ disabled: false });
  });

  it('auto-clears state when cooldown has elapsed', () => {
    // Manually write a state file with a timestamp in the distant past
    const expired = {
      reason: 'expired',
      disabledAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    };
    writeFileSync(STATE_FILE, JSON.stringify(expired));

    expect(isAutoMergeDisabled()).toEqual({ disabled: false });
    // The check itself should have unlinked the expired file
    expect(existsSync(STATE_FILE)).toBe(false);
  });

  it('keeps state when cooldown has NOT elapsed', () => {
    const fresh = {
      reason: 'still fresh',
      disabledAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 min ago
    };
    writeFileSync(STATE_FILE, JSON.stringify(fresh));

    const status = isAutoMergeDisabled();
    expect(status.disabled).toBe(true);
    expect(existsSync(STATE_FILE)).toBe(true);
  });

  it('treats corrupt state file as cleared', () => {
    writeFileSync(STATE_FILE, 'not json{{{');
    expect(isAutoMergeDisabled()).toEqual({ disabled: false });
    expect(existsSync(STATE_FILE)).toBe(false);
  });

  it('treats malformed-but-parseable JSON as cleared (missing disabledAt)', () => {
    // Without shape validation, missing disabledAt would parse as undefined,
    // making `NaN >= cooldown` false and trapping the breaker indefinitely.
    writeFileSync(STATE_FILE, JSON.stringify({ reason: 'no timestamp' }));
    expect(isAutoMergeDisabled()).toEqual({ disabled: false });
    expect(existsSync(STATE_FILE)).toBe(false);
  });

  it('treats malformed-but-parseable JSON as cleared (wrong-typed disabledAt)', () => {
    writeFileSync(
      STATE_FILE,
      JSON.stringify({ reason: 'wrong type', disabledAt: 12345 }),
    );
    expect(isAutoMergeDisabled()).toEqual({ disabled: false });
    expect(existsSync(STATE_FILE)).toBe(false);
  });

  it('treats unparseable disabledAt date string as cleared', () => {
    writeFileSync(
      STATE_FILE,
      JSON.stringify({ reason: 'bad date', disabledAt: 'not-a-real-date' }),
    );
    expect(isAutoMergeDisabled()).toEqual({ disabled: false });
    expect(existsSync(STATE_FILE)).toBe(false);
  });
});
