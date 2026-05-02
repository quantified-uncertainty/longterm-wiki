import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getSlotTmpDir, ensureSlotTmpDir } from '../tsx-cache-isolation.ts';

describe('getSlotTmpDir', () => {
  it('returns deterministic per-slot paths under os.tmpdir()', () => {
    const a2 = getSlotTmpDir(2);
    const a15 = getSlotTmpDir(15);
    expect(a2).toBe(join(tmpdir(), 'tsx-slot-a2'));
    expect(a15).toBe(join(tmpdir(), 'tsx-slot-a15'));
    expect(a2).not.toBe(a15);
  });

  it('is stable across calls (same slot → same path)', () => {
    expect(getSlotTmpDir(7)).toBe(getSlotTmpDir(7));
  });

  it('rejects non-positive or non-integer slots', () => {
    expect(() => getSlotTmpDir(0)).toThrow(/positive integer/);
    expect(() => getSlotTmpDir(-1)).toThrow(/positive integer/);
    expect(() => getSlotTmpDir(1.5)).toThrow(/positive integer/);
    expect(() => getSlotTmpDir(NaN)).toThrow(/positive integer/);
  });
});

describe('ensureSlotTmpDir', () => {
  // Use slot numbers far from any real slot to avoid colliding with live
  // workspace state. Cleanup runs in afterEach regardless of test outcome.
  const TEST_SLOTS = [9001, 9002, 9003];

  afterEach(() => {
    for (const slot of TEST_SLOTS) {
      rmSync(getSlotTmpDir(slot), { recursive: true, force: true });
    }
  });

  it('creates the slot directory and returns its path', () => {
    const dir = ensureSlotTmpDir(9001);
    expect(dir).toBe(getSlotTmpDir(9001));
    expect(existsSync(dir)).toBe(true);
  });

  it('is idempotent — repeated calls do not throw', () => {
    expect(() => ensureSlotTmpDir(9002)).not.toThrow();
    expect(() => ensureSlotTmpDir(9002)).not.toThrow();
    expect(() => ensureSlotTmpDir(9002)).not.toThrow();
    expect(existsSync(getSlotTmpDir(9002))).toBe(true);
  });

  it('rejects invalid slots before creating anything', () => {
    expect(() => ensureSlotTmpDir(0)).toThrow(/positive integer/);
    expect(() => ensureSlotTmpDir(-5)).toThrow(/positive integer/);
  });
});
