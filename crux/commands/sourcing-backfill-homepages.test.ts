/**
 * Tests for `crux sourcing-backfill-homepages` pure helpers.
 *
 * Focus: `selectCandidates` (filter + idempotency), `groupByDomain`,
 * `parseLimit`. The command's control flow (--dry-run / --apply gating,
 * chunked writes, upsertResourceBatch call) is exercised via prod dry-run
 * smoke tests outside the unit suite.
 */

import { describe, it, expect } from 'vitest';
import {
  selectCandidates,
  groupByDomain,
  parseLimit,
  type BackfillCandidate,
} from './sourcing-backfill-homepages.ts';
import type { Resource } from '../resource-types.ts';

// ── Test helpers ────────────────────────────────────────────────────

function r(
  overrides: { id: string; url: string; title?: string; type?: string; enrichment_status?: string | null },
): Resource {
  return {
    id: overrides.id,
    url: overrides.url,
    title: overrides.title ?? `Title for ${overrides.id}`,
    type: overrides.type ?? 'web',
    enrichment_status: overrides.enrichment_status ?? null,
  } as unknown as Resource;
}

// ── selectCandidates ────────────────────────────────────────────────

describe('selectCandidates', () => {
  it('returns bare-domain URLs as candidates', () => {
    const pool = [
      r({ id: 'r1', url: 'https://anthropic.com/' }),
      r({ id: 'r2', url: 'https://openai.com/' }),
    ];
    const result = selectCandidates(pool);
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.id).sort()).toEqual(['r1', 'r2']);
    for (const c of result) {
      expect(c.confidence).toBeGreaterThanOrEqual(0.8);
    }
  });

  it('returns /about-style paths as candidates', () => {
    const pool = [
      r({ id: 'r1', url: 'https://openai.com/about' }),
      r({ id: 'r2', url: 'https://google.com/contact' }),
      r({ id: 'r3', url: 'https://example.com/index.html' }),
    ];
    const result = selectCandidates(pool);
    expect(result).toHaveLength(3);
  });

  it('skips deep paths (articles, papers)', () => {
    const pool = [
      r({ id: 'r1', url: 'https://www.lesswrong.com/posts/abc/some-article' }),
      r({ id: 'r2', url: 'https://arxiv.org/abs/2301.00001' }),
      r({ id: 'r3', url: 'https://example.com/blog/2024/my-post' }),
    ];
    const result = selectCandidates(pool);
    expect(result).toHaveLength(0);
  });

  it('skips PDFs (confident non-homepage)', () => {
    const pool = [
      r({ id: 'r1', url: 'https://example.com/report.pdf' }),
      r({ id: 'r2', url: 'https://example.com/doc.pdf' }),
    ];
    const result = selectCandidates(pool);
    expect(result).toHaveLength(0);
  });

  it('skips URLs with data-like query params (not homepages)', () => {
    const pool = [
      r({ id: 'r1', url: 'https://example.com/?id=42' }),
      r({ id: 'r2', url: 'https://youtube.com/?v=abc' }),
    ];
    const result = selectCandidates(pool);
    expect(result).toHaveLength(0);
  });

  it('keeps bare domains with utm_* tracking params', () => {
    const pool = [
      r({ id: 'r1', url: 'https://example.com/?utm_source=x&utm_campaign=y' }),
    ];
    const result = selectCandidates(pool);
    expect(result).toHaveLength(1);
  });

  it('skips resources without a URL', () => {
    const pool = [
      r({ id: 'r1', url: '' }),
      r({ id: 'r2', url: 'https://anthropic.com/' }),
    ];
    const result = selectCandidates(pool);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('r2');
  });

  it('skips already-classified resources (idempotency)', () => {
    const pool = [
      r({ id: 'r1', url: 'https://anthropic.com/', enrichment_status: 'classified' }),
      r({ id: 'r2', url: 'https://openai.com/', enrichment_status: null }),
    ];
    const result = selectCandidates(pool);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('r2');
  });

  it('skips already-enriched and already-reviewed resources', () => {
    const pool = [
      r({ id: 'r1', url: 'https://anthropic.com/', enrichment_status: 'enriched' }),
      r({ id: 'r2', url: 'https://openai.com/', enrichment_status: 'reviewed' }),
      r({ id: 'r3', url: 'https://example.com/', enrichment_status: null }),
    ];
    const result = selectCandidates(pool);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('r3');
  });

  it('respects a custom threshold', () => {
    // /about has confidence 0.85; raising threshold to 0.9 excludes it,
    // but bare-domain (0.95) remains.
    const pool = [
      r({ id: 'r1', url: 'https://anthropic.com/about' }), // 0.85
      r({ id: 'r2', url: 'https://openai.com/' }),          // 0.95
    ];
    const result = selectCandidates(pool, 0.9);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('r2');
  });

  it('normalizes www. prefix in the host field', () => {
    const pool = [
      r({ id: 'r1', url: 'https://www.anthropic.com/' }),
    ];
    const result = selectCandidates(pool);
    expect(result[0].host).toBe('anthropic.com');
  });

  it('returns an empty array for an empty pool', () => {
    expect(selectCandidates([])).toEqual([]);
  });

  it('handles mixed pool with realistic distribution (2-4% hit rate)', () => {
    // 100 resources: 3 homepages, 97 deep-path articles
    const pool: Resource[] = [];
    for (let i = 0; i < 97; i++) {
      pool.push(r({ id: `post${i}`, url: `https://lesswrong.com/posts/${i}/slug` }));
    }
    pool.push(r({ id: 'hp1', url: 'https://anthropic.com/' }));
    pool.push(r({ id: 'hp2', url: 'https://openai.com/' }));
    pool.push(r({ id: 'hp3', url: 'https://google.com/about' }));

    const result = selectCandidates(pool);
    expect(result).toHaveLength(3);
    expect(new Set(result.map((c) => c.id))).toEqual(new Set(['hp1', 'hp2', 'hp3']));
  });

  it('returns classifier reasons alongside the candidate', () => {
    const pool = [r({ id: 'r1', url: 'https://anthropic.com/' })];
    const result = selectCandidates(pool);
    expect(result[0].reasons).toContain('root-path');
  });

  it('skips URL shorteners (confidence 0, purpose=null)', () => {
    const pool = [
      r({ id: 'r1', url: 'https://bit.ly/abc123' }),
      r({ id: 'r2', url: 'https://t.co/xyz' }),
    ];
    const result = selectCandidates(pool);
    expect(result).toHaveLength(0);
  });

  it('skips Wayback-wrapped non-homepage URLs but keeps wrapped bare domains', () => {
    const pool = [
      r({ id: 'r1', url: 'https://web.archive.org/web/20240101000000/https://anthropic.com/' }),
      r({ id: 'r2', url: 'https://web.archive.org/web/20240101000000/https://lesswrong.com/posts/abc/slug' }),
    ];
    const result = selectCandidates(pool);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('r1');
  });
});

// ── groupByDomain ───────────────────────────────────────────────────

describe('groupByDomain', () => {
  function cand(id: string, host: string): BackfillCandidate {
    return { id, url: `https://${host}/`, host, confidence: 0.95, reasons: [] };
  }

  it('counts candidates per host', () => {
    const result = groupByDomain([
      cand('a', 'anthropic.com'),
      cand('b', 'anthropic.com'),
      cand('c', 'openai.com'),
    ]);
    expect(result).toEqual([
      { host: 'anthropic.com', count: 2, sampleId: 'a' },
      { host: 'openai.com', count: 1, sampleId: 'c' },
    ]);
  });

  it('sorts by count descending, then host alphabetically', () => {
    const result = groupByDomain([
      cand('1', 'z.com'),
      cand('2', 'a.com'),
      cand('3', 'a.com'),
      cand('4', 'b.com'),
      cand('5', 'b.com'),
    ]);
    expect(result.map((d) => d.host)).toEqual(['a.com', 'b.com', 'z.com']);
  });

  it('returns empty for empty input', () => {
    expect(groupByDomain([])).toEqual([]);
  });

  it('sampleId is the first candidate seen for that host', () => {
    const result = groupByDomain([
      cand('alice', 'example.com'),
      cand('bob', 'example.com'),
      cand('carol', 'example.com'),
    ]);
    expect(result[0].sampleId).toBe('alice');
  });
});

// ── parseLimit ──────────────────────────────────────────────────────

describe('parseLimit', () => {
  it('returns null when omitted', () => {
    expect(parseLimit(undefined)).toBeNull();
    expect(parseLimit(null)).toBeNull();
    expect(parseLimit('')).toBeNull();
  });

  it('parses numeric strings', () => {
    expect(parseLimit('10')).toBe(10);
    expect(parseLimit('500')).toBe(500);
    expect(parseLimit(100)).toBe(100);
  });

  it('returns null on non-numeric input', () => {
    expect(parseLimit('abc')).toBeNull();
  });

  it('returns null on zero or negative', () => {
    expect(parseLimit('0')).toBeNull();
    expect(parseLimit('-1')).toBeNull();
    expect(parseLimit(-10)).toBeNull();
  });

  it('does NOT clamp to any max (unlike sample-size)', () => {
    // parseLimit is just a cap; the command can accept any positive count.
    expect(parseLimit('999999')).toBe(999999);
  });
});
