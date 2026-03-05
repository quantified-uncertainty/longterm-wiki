/**
 * Tests for crux/health/checks/pr-quality.ts
 *
 * Verifies:
 *   - hoursAgoFromNow correctly calculates time differences
 *   - Edge cases: zero difference, future dates, exactly at threshold
 */

import { describe, it, expect } from 'vitest';
import { hoursAgoFromNow } from './pr-quality.ts';

describe('hoursAgoFromNow', () => {
  it('returns 0 for a timestamp equal to now', () => {
    const now = Date.now();
    const iso = new Date(now).toISOString();
    expect(hoursAgoFromNow(iso, now)).toBe(0);
  });

  it('returns correct hours for a timestamp in the past', () => {
    const now = Date.now();
    const threeHoursAgo = new Date(now - 3 * 3_600_000).toISOString();
    expect(hoursAgoFromNow(threeHoursAgo, now)).toBe(3);
  });

  it('returns correct hours for exactly 8 hours (stuck label threshold)', () => {
    const now = Date.now();
    const eightHoursAgo = new Date(now - 8 * 3_600_000).toISOString();
    expect(hoursAgoFromNow(eightHoursAgo, now)).toBe(8);
  });

  it('returns correct hours for exactly 168 hours (7 days, stale PR threshold)', () => {
    const now = Date.now();
    const sevenDaysAgo = new Date(now - 168 * 3_600_000).toISOString();
    expect(hoursAgoFromNow(sevenDaysAgo, now)).toBe(168);
  });

  it('handles negative results (future timestamps) by rounding', () => {
    const now = Date.now();
    const oneHourFromNow = new Date(now + 3_600_000).toISOString();
    // Negative value since the timestamp is in the future
    expect(hoursAgoFromNow(oneHourFromNow, now)).toBe(-1);
  });

  it('rounds partial hours correctly', () => {
    const now = Date.now();
    // 2.6 hours ago -> rounds to 3
    const ago = new Date(now - 2.6 * 3_600_000).toISOString();
    expect(hoursAgoFromNow(ago, now)).toBe(3);
  });

  it('handles large time differences (30 days)', () => {
    const now = Date.now();
    const thirtyDaysAgo = new Date(now - 30 * 24 * 3_600_000).toISOString();
    expect(hoursAgoFromNow(thirtyDaysAgo, now)).toBe(720);
  });

  it('uses Date.now() as default when now parameter is omitted', () => {
    const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const result = hoursAgoFromNow(oneHourAgo);
    // Should be approximately 1 (allow small timing variance)
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(2);
  });
});
