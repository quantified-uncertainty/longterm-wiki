/**
 * Tests for crux/health/checks/ci-main-health.ts
 *
 * Verifies the helper functions and documents the logic boundaries
 * for the CI main branch health check.
 */

import { describe, it, expect } from 'vitest';
import { hoursAgoCI, isWithinHours } from './ci-main-health.ts';

describe('hoursAgoCI', () => {
  it('returns 0 for a timestamp equal to now', () => {
    const now = Date.now();
    const iso = new Date(now).toISOString();
    expect(hoursAgoCI(iso, now)).toBe(0);
  });

  it('returns correct fractional hours for a timestamp in the past', () => {
    const now = Date.now();
    // 3 hours ago exactly
    const threeHoursAgo = new Date(now - 3 * 3_600_000).toISOString();
    expect(hoursAgoCI(threeHoursAgo, now)).toBe(3);
  });

  it('returns fractional hours (not rounded)', () => {
    const now = Date.now();
    // 1.5 hours ago
    const ago = new Date(now - 1.5 * 3_600_000).toISOString();
    expect(hoursAgoCI(ago, now)).toBe(1.5);
  });

  it('returns negative for future timestamps', () => {
    const now = Date.now();
    const future = new Date(now + 3_600_000).toISOString();
    expect(hoursAgoCI(future, now)).toBe(-1);
  });

  it('handles 24 hours correctly', () => {
    const now = Date.now();
    const twentyFourHoursAgo = new Date(now - 24 * 3_600_000).toISOString();
    expect(hoursAgoCI(twentyFourHoursAgo, now)).toBe(24);
  });

  it('uses Date.now() as default', () => {
    const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const result = hoursAgoCI(oneHourAgo);
    // Should be approximately 1 (allow small timing variance)
    expect(result).toBeGreaterThanOrEqual(0.9);
    expect(result).toBeLessThanOrEqual(1.1);
  });
});

describe('isWithinHours', () => {
  it('returns true for a timestamp exactly at the threshold', () => {
    const now = Date.now();
    const exactly24h = new Date(now - 24 * 3_600_000).toISOString();
    expect(isWithinHours(exactly24h, 24, now)).toBe(true);
  });

  it('returns false for a timestamp just beyond the threshold', () => {
    const now = Date.now();
    // 24h + 1ms ago
    const justOver24h = new Date(now - (24 * 3_600_000 + 1)).toISOString();
    // hoursAgoCI returns fractional — just barely over 24
    expect(isWithinHours(justOver24h, 24, now)).toBe(false);
  });

  it('returns true for a recent timestamp (1h ago)', () => {
    const now = Date.now();
    const oneHourAgo = new Date(now - 3_600_000).toISOString();
    expect(isWithinHours(oneHourAgo, 24, now)).toBe(true);
  });

  it('returns false for a timestamp 25h ago when threshold is 24h', () => {
    const now = Date.now();
    const twentyFiveHoursAgo = new Date(now - 25 * 3_600_000).toISOString();
    expect(isWithinHours(twentyFiveHoursAgo, 24, now)).toBe(false);
  });

  it('returns true for a future timestamp (negative hoursAgo)', () => {
    const now = Date.now();
    const future = new Date(now + 3_600_000).toISOString();
    // A run created in the future (clock skew) should still count as recent
    expect(isWithinHours(future, 24, now)).toBe(true);
  });

  it('works with custom threshold values', () => {
    const now = Date.now();
    const tenHoursAgo = new Date(now - 10 * 3_600_000).toISOString();
    expect(isWithinHours(tenHoursAgo, 12, now)).toBe(true);
    expect(isWithinHours(tenHoursAgo, 8, now)).toBe(false);
  });
});
