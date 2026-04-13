/**
 * Tests for `crux sourcing-sample-coverage` pure helpers.
 *
 * Focus: parseSampleSize, parseSeed, createRng (mulberry32 properties),
 * sampleWithoutReplacement (no replacement + reproducibility), and
 * computeCoverageStats (bucketing, gate verdict, byDomain sorting).
 *
 * The command's control flow (loadResourcesPGFirst + flag handling) is
 * verified by running against prod data manually; these tests pin down the
 * pure logic so regressions are caught mechanically.
 */

import { describe, it, expect } from 'vitest';
import {
  parseSampleSize,
  parseSeed,
  createRng,
  sampleWithoutReplacement,
  computeCoverageStats,
} from './sourcing-sample-coverage.ts';

// ── parseSampleSize ─────────────────────────────────────────────────

describe('parseSampleSize', () => {
  it('returns default 500 when omitted', () => {
    expect(parseSampleSize(undefined)).toBe(500);
  });

  it('parses numeric string', () => {
    expect(parseSampleSize('100')).toBe(100);
    expect(parseSampleSize('2500')).toBe(2500);
  });

  it('clamps above MAX_SAMPLE_SIZE (5000)', () => {
    expect(parseSampleSize('99999')).toBe(5000);
    expect(parseSampleSize('5001')).toBe(5000);
  });

  it('returns default on non-numeric input', () => {
    expect(parseSampleSize('abc')).toBe(500);
    expect(parseSampleSize('')).toBe(500);
    expect(parseSampleSize(null)).toBe(500);
  });

  it('returns default on zero or negative', () => {
    expect(parseSampleSize('0')).toBe(500);
    expect(parseSampleSize('-10')).toBe(500);
    expect(parseSampleSize(-10)).toBe(500);
  });

  it('accepts numeric value directly', () => {
    expect(parseSampleSize(1000)).toBe(1000);
  });
});

// ── parseSeed ───────────────────────────────────────────────────────

describe('parseSeed', () => {
  it('returns null when omitted', () => {
    expect(parseSeed(undefined)).toBeNull();
    expect(parseSeed(null)).toBeNull();
    expect(parseSeed('')).toBeNull();
  });

  it('parses numeric strings to uint32', () => {
    expect(parseSeed('0')).toBe(0);
    expect(parseSeed('1')).toBe(1);
    expect(parseSeed('42')).toBe(42);
    expect(parseSeed('4294967295')).toBe(4294967295);
  });

  it('returns null on non-numeric input', () => {
    expect(parseSeed('abc')).toBeNull();
    expect(parseSeed('1.5')).toBe(1); // parseInt truncates
  });

  it('returns null on negative input', () => {
    expect(parseSeed('-1')).toBeNull();
    expect(parseSeed(-5)).toBeNull();
  });
});

// ── createRng (mulberry32) ──────────────────────────────────────────

describe('createRng', () => {
  it('produces the same sequence for the same seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    for (let i = 0; i < 10; i++) {
      expect(a()).toBe(b());
    }
  });

  it('produces different sequences for different seeds', () => {
    const a = createRng(1);
    const b = createRng(2);
    const firstA = a();
    const firstB = b();
    expect(firstA).not.toBe(firstB);
  });

  it('returns floats in [0, 1)', () => {
    const rng = createRng(12345);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('seed 0 is distinct from seed 1 (no off-by-one weirdness)', () => {
    const a = createRng(0);
    const b = createRng(1);
    expect(a()).not.toBe(b());
  });
});

// ── sampleWithoutReplacement ────────────────────────────────────────

describe('sampleWithoutReplacement', () => {
  const pool = Array.from({ length: 100 }, (_, i) => i);

  it('returns exactly sampleSize items when pool >= sampleSize', () => {
    const result = sampleWithoutReplacement(pool, 10, createRng(1));
    expect(result).toHaveLength(10);
  });

  it('returns no duplicates (true "without replacement")', () => {
    const result = sampleWithoutReplacement(pool, 50, createRng(1));
    expect(new Set(result).size).toBe(50);
  });

  it('returns pool.length items when sampleSize >= pool.length', () => {
    const result = sampleWithoutReplacement(pool, 500, createRng(1));
    expect(result).toHaveLength(100);
    // Every element in pool is present exactly once
    expect(new Set(result)).toEqual(new Set(pool));
  });

  it('returns empty for empty pool', () => {
    expect(sampleWithoutReplacement([], 10, createRng(1))).toEqual([]);
  });

  it('returns empty for zero sample size', () => {
    expect(sampleWithoutReplacement(pool, 0, createRng(1))).toEqual([]);
  });

  it('returns empty for negative sample size', () => {
    expect(sampleWithoutReplacement(pool, -5, createRng(1))).toEqual([]);
  });

  it('does not mutate the input pool', () => {
    const copy = [...pool];
    sampleWithoutReplacement(pool, 50, createRng(1));
    expect(pool).toEqual(copy);
  });

  it('is deterministic for the same seed', () => {
    const a = sampleWithoutReplacement(pool, 30, createRng(42));
    const b = sampleWithoutReplacement(pool, 30, createRng(42));
    expect(a).toEqual(b);
  });

  it('produces different samples for different seeds', () => {
    const a = sampleWithoutReplacement(pool, 30, createRng(1));
    const b = sampleWithoutReplacement(pool, 30, createRng(2));
    expect(a).not.toEqual(b);
  });

  it('falls back to Math.random when rng is null', () => {
    const result = sampleWithoutReplacement(pool, 10, null);
    expect(result).toHaveLength(10);
    expect(new Set(result).size).toBe(10);
  });

  it('distribution: samples a single element uniformly (rough check)', () => {
    const counts = new Map<number, number>();
    for (let i = 0; i < 10000; i++) {
      const [picked] = sampleWithoutReplacement(pool, 1, createRng(i));
      counts.set(picked, (counts.get(picked) ?? 0) + 1);
    }
    // Every element in the 100-item pool should have been picked at least once.
    expect(counts.size).toBe(100);
    // No single element should dominate (>2x uniform).
    for (const cnt of counts.values()) {
      expect(cnt).toBeLessThan(200);
    }
  });
});

// ── computeCoverageStats ────────────────────────────────────────────

describe('computeCoverageStats', () => {
  it('counts fast-path hits for bare-domain URLs', () => {
    const sample = [
      { url: 'https://anthropic.com/' },
      { url: 'https://openai.com/' },
      { url: 'https://example.com/' },
    ];
    const stats = computeCoverageStats(sample);
    expect(stats.sampled).toBe(3);
    expect(stats.fastPathHits).toBe(3);
    expect(stats.fastPathHitRate).toBe(1.0);
    expect(stats.meetsThreshold).toBe(true);
  });

  it('does NOT count deep URLs as fast-path hits', () => {
    const sample = [
      { url: 'https://example.com/blog/2024/post' },
      { url: 'https://example.com/team/jane-doe' },
    ];
    const stats = computeCoverageStats(sample);
    expect(stats.fastPathHits).toBe(0);
    expect(stats.flagHits).toBe(0);
  });

  it('computes hit rate correctly on mixed input', () => {
    const sample = [
      { url: 'https://anthropic.com/' },        // fast-path
      { url: 'https://openai.com/' },           // fast-path
      { url: 'https://openai.com/about' },      // fast-path (flag=0.85, fp=0.85)
      { url: 'https://example.com/blog/post' }, // not
      { url: 'https://arxiv.org/abs/2301.00001' }, // not
    ];
    const stats = computeCoverageStats(sample);
    expect(stats.fastPathHits).toBe(3);
    expect(stats.fastPathHitRate).toBeCloseTo(0.6, 5);
    expect(stats.meetsThreshold).toBe(true);
  });

  it('triggers STOP verdict below the 40% gate', () => {
    const sample = [
      { url: 'https://example.com/' },          // 1 fast-path
      { url: 'https://example.com/blog/post' }, // 4 non-hits
      { url: 'https://example.com/team/jane' },
      { url: 'https://example.com/docs/api' },
      { url: 'https://arxiv.org/abs/2301' },
    ];
    const stats = computeCoverageStats(sample);
    expect(stats.fastPathHitRate).toBeCloseTo(0.2, 5);
    expect(stats.meetsThreshold).toBe(false);
  });

  it('respects a custom gate threshold', () => {
    const sample = [
      { url: 'https://example.com/' },
      { url: 'https://example.com/blog/post' },
    ];
    // 50% hit rate
    expect(computeCoverageStats(sample, 0.4).meetsThreshold).toBe(true);
    expect(computeCoverageStats(sample, 0.6).meetsThreshold).toBe(false);
  });

  it('counts unparseable URLs separately', () => {
    const sample = [
      { url: 'not a url' },
      { url: 'https://example.com/' },
    ];
    const stats = computeCoverageStats(sample);
    expect(stats.unparseable).toBe(1);
    expect(stats.fastPathHits).toBe(1);
  });

  it('counts empty URL as unparseable', () => {
    const sample = [
      { url: '' },
      { url: 'https://example.com/' },
    ];
    const stats = computeCoverageStats(sample);
    expect(stats.unparseable).toBe(1);
    expect(stats.fastPathHits).toBe(1);
  });

  it('tracks nullPurposeButConfident for PDFs', () => {
    const sample = [
      { url: 'https://example.com/report.pdf' }, // PDF: purpose=null, confidence=0.9
      { url: 'https://example.com/' },           // fast-path
    ];
    const stats = computeCoverageStats(sample);
    expect(stats.nullPurposeButConfident).toBe(1);
    expect(stats.fastPathHits).toBe(1);
  });

  it('byDomain sorted by fast-path hit count descending', () => {
    const sample = [
      { url: 'https://anthropic.com/' },
      { url: 'https://anthropic.com/about' },
      { url: 'https://anthropic.com/contact' },
      { url: 'https://openai.com/' },
      { url: 'https://openai.com/about' },
      { url: 'https://google.com/' },
    ];
    const stats = computeCoverageStats(sample);
    expect(stats.byDomain[0].host).toBe('anthropic.com');
    expect(stats.byDomain[0].fastPathHits).toBe(3);
    expect(stats.byDomain[1].host).toBe('openai.com');
    expect(stats.byDomain[1].fastPathHits).toBe(2);
    expect(stats.byDomain[2].host).toBe('google.com');
  });

  it('byDomain filters out domains with zero fast-path hits', () => {
    const sample = [
      { url: 'https://example.com/' },               // anthropic.com has 0 hits
      { url: 'https://arxiv.org/abs/2301.00001' },   // arxiv has 0 hits (deep path)
    ];
    const stats = computeCoverageStats(sample);
    // example.com had a fast-path hit; arxiv.org has 0 — filtered out
    expect(stats.byDomain.map((d) => d.host)).toEqual(['example.com']);
  });

  it('normalizes www. prefix for domain grouping', () => {
    const sample = [
      { url: 'https://www.anthropic.com/' },
      { url: 'https://anthropic.com/' },
    ];
    const stats = computeCoverageStats(sample);
    expect(stats.byDomain).toHaveLength(1);
    expect(stats.byDomain[0].host).toBe('anthropic.com');
    expect(stats.byDomain[0].fastPathHits).toBe(2);
  });

  it('handles empty sample gracefully', () => {
    const stats = computeCoverageStats([]);
    expect(stats.sampled).toBe(0);
    expect(stats.fastPathHits).toBe(0);
    expect(stats.fastPathHitRate).toBe(0);
    expect(stats.meetsThreshold).toBe(false);
    expect(stats.byDomain).toEqual([]);
  });

  it('handles URLs with tracking params alone as homepage', () => {
    // utm_* params should not disqualify a bare domain from being a homepage
    const sample = [{ url: 'https://example.com/?utm_source=x' }];
    const stats = computeCoverageStats(sample);
    expect(stats.fastPathHits).toBe(1);
  });

  it('does NOT count URLs with data-like query params as homepage', () => {
    const sample = [
      { url: 'https://example.com/?id=42' },  // data param → not homepage
      { url: 'https://youtube.com/?v=abc' },   // data param → not homepage
    ];
    const stats = computeCoverageStats(sample);
    expect(stats.fastPathHits).toBe(0);
  });
});
