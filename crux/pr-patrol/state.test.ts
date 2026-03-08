import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

import {
  MAIN_BRANCH_COOLDOWN_SECONDS,
  MAIN_BRANCH_ABANDON_THRESHOLD,
  isMainBranchAbandoned,
  trackMainFixPr,
  getTrackedMainFixPr,
  clearTrackedMainFixPr,
  clearProcessed,
  ensureDirs,
  markProcessed,
  isRecentlyProcessed,
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
