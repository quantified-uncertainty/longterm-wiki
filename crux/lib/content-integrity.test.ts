import { describe, it, expect } from 'vitest';
import {
  findFootnoteRefs,
  findFootnoteDefs,
  detectOrphanedFootnotes,
  detectDuplicateFootnoteDefs,
  detectSequentialArxivIds,
  detectUnsourcedFootnotes,
  computeIntegrityRisk,
  assessContentIntegrity,
} from './content-integrity.ts';

// ---------------------------------------------------------------------------
// findFootnoteRefs
// ---------------------------------------------------------------------------

describe('findFootnoteRefs', () => {
  it('finds inline footnote references', () => {
    const body = 'Some claim[^1] and another[^2] and repeated[^1].';
    expect(findFootnoteRefs(body)).toEqual(new Set([1, 2]));
  });

  it('excludes definition lines', () => {
    const body = `Some claim[^1] here.

[^1]: This is the definition with [^2] inside it.`;
    // Only [^1] from the body, not [^2] from the definition line
    expect(findFootnoteRefs(body)).toEqual(new Set([1]));
  });

  it('returns empty set when no refs', () => {
    expect(findFootnoteRefs('No footnotes here.')).toEqual(new Set());
  });
});

// ---------------------------------------------------------------------------
// findFootnoteDefs
// ---------------------------------------------------------------------------

describe('findFootnoteDefs', () => {
  it('finds footnote definitions', () => {
    const body = `Some text.

[^1]: First source https://example.com
[^2]: Second source`;
    expect(findFootnoteDefs(body)).toEqual(new Set([1, 2]));
  });

  it('returns empty set when no definitions', () => {
    expect(findFootnoteDefs('No definitions.')).toEqual(new Set());
  });
});

// ---------------------------------------------------------------------------
// detectOrphanedFootnotes
// ---------------------------------------------------------------------------

describe('detectOrphanedFootnotes', () => {
  it('detects no orphans when all refs have definitions', () => {
    const body = `Claim[^1] and another[^2].

[^1]: Source one https://example.com
[^2]: Source two https://example.com`;
    const result = detectOrphanedFootnotes(body);
    expect(result.orphanedRefs).toEqual([]);
    expect(result.orphanedRatio).toBe(0);
  });

  it('detects orphaned refs (truncated page)', () => {
    const body = `Claim[^1] and another[^2] and more[^3].

[^1]: Source one https://example.com`;
    // [^2] and [^3] have no definitions
    const result = detectOrphanedFootnotes(body);
    expect(result.orphanedRefs).toEqual([2, 3]);
    expect(result.totalRefs).toBe(3);
    expect(result.totalDefs).toBe(1);
    expect(result.orphanedRatio).toBeCloseTo(2 / 3);
  });

  it('detects all orphaned (fully truncated)', () => {
    const body = 'Claim[^1] and another[^2] and more[^3].';
    const result = detectOrphanedFootnotes(body);
    expect(result.orphanedRefs).toEqual([1, 2, 3]);
    expect(result.orphanedRatio).toBe(1);
  });

  it('handles page with no footnotes at all', () => {
    const result = detectOrphanedFootnotes('Just plain text.');
    expect(result.orphanedRefs).toEqual([]);
    expect(result.orphanedRatio).toBe(0);
    expect(result.totalRefs).toBe(0);
    expect(result.totalDefs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// detectDuplicateFootnoteDefs
// ---------------------------------------------------------------------------

describe('detectDuplicateFootnoteDefs', () => {
  it('detects no duplicates when all unique', () => {
    const body = `[^1]: Source one
[^2]: Source two`;
    expect(detectDuplicateFootnoteDefs(body)).toEqual([]);
  });

  it('detects duplicate definitions', () => {
    const body = `[^1]: Source one
[^2]: Source two
[^1]: Duplicate of source one`;
    expect(detectDuplicateFootnoteDefs(body)).toEqual([1]);
  });

  it('handles no definitions', () => {
    expect(detectDuplicateFootnoteDefs('No defs.')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectSequentialArxivIds
// ---------------------------------------------------------------------------

describe('detectSequentialArxivIds', () => {
  it('detects sequential arxiv IDs', () => {
    const body = `
Some paper (2506.00001) and next (2506.00002) and third (2506.00003).
`;
    const result = detectSequentialArxivIds(body);
    expect(result.suspicious).toBe(true);
    expect(result.longestRun).toBe(3);
    expect(result.sequentialIds).toEqual(['2506.00001', '2506.00002', '2506.00003']);
  });

  it('detects long runs of fabricated IDs', () => {
    const ids = Array.from({ length: 10 }, (_, i) =>
      `2506.${String(i).padStart(5, '0')}`
    ).join(', ');
    const body = `References: ${ids}`;
    const result = detectSequentialArxivIds(body);
    expect(result.suspicious).toBe(true);
    expect(result.longestRun).toBe(10);
  });

  it('does not flag non-sequential IDs', () => {
    const body = `
Real papers: 2301.07041, 2305.14314, 2310.01234.
`;
    const result = detectSequentialArxivIds(body);
    expect(result.suspicious).toBe(false);
    expect(result.longestRun).toBeLessThan(3);
  });

  it('does not flag fewer than minRunLength sequential IDs', () => {
    const body = 'Papers: 2506.00001, 2506.00002';
    const result = detectSequentialArxivIds(body, 3);
    expect(result.suspicious).toBe(false);
  });

  it('handles no arxiv-like IDs', () => {
    const result = detectSequentialArxivIds('No arxiv references here.');
    expect(result.suspicious).toBe(false);
    expect(result.longestRun).toBe(0);
  });

  it('respects custom minRunLength', () => {
    const body = 'Papers: 2506.00001, 2506.00002';
    expect(detectSequentialArxivIds(body, 2).suspicious).toBe(true);
    expect(detectSequentialArxivIds(body, 3).suspicious).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectUnsourcedFootnotes
// ---------------------------------------------------------------------------

describe('detectUnsourcedFootnotes', () => {
  it('detects footnotes with URLs as sourced', () => {
    const body = `[^1]: Source https://example.com/paper
[^2]: Another https://arxiv.org/abs/2301.12345`;
    const result = detectUnsourcedFootnotes(body);
    expect(result.unsourced).toBe(0);
    expect(result.totalDefs).toBe(2);
    expect(result.unsourcedRatio).toBe(0);
  });

  it('detects unsourced footnotes (no URL)', () => {
    const body = `[^1]: Just some text without a link.
[^2]: Source https://example.com`;
    const result = detectUnsourcedFootnotes(body);
    expect(result.unsourced).toBe(1);
    expect(result.totalDefs).toBe(2);
    expect(result.unsourcedRatio).toBe(0.5);
  });

  it('handles multi-line footnote definitions', () => {
    const body = `[^1]: This is a long footnote that continues
    on the next line with a URL https://example.com
[^2]: This has no URL
    even on continuation lines.`;
    const result = detectUnsourcedFootnotes(body);
    expect(result.unsourced).toBe(1); // [^2] has no URL
    expect(result.totalDefs).toBe(2);
  });

  it('handles empty body', () => {
    const result = detectUnsourcedFootnotes('');
    expect(result.unsourced).toBe(0);
    expect(result.totalDefs).toBe(0);
    expect(result.unsourcedRatio).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeIntegrityRisk
// ---------------------------------------------------------------------------

describe('computeIntegrityRisk', () => {
  it('returns 0 for clean page', () => {
    const integrity = assessContentIntegrity(`Claim[^1] here.

[^1]: Source https://example.com`);
    const { score, factors } = computeIntegrityRisk(integrity);
    expect(score).toBe(0);
    expect(factors).toEqual([]);
  });

  it('returns high score for severely truncated page', () => {
    // 3 refs, 0 defs = 100% orphaned
    const integrity = assessContentIntegrity(
      'Claim[^1] and[^2] and[^3].'
    );
    const { score, factors } = computeIntegrityRisk(integrity);
    expect(score).toBe(30);
    expect(factors).toContain('severe-truncation');
  });

  it('returns moderate score for partial orphaning', () => {
    const integrity = assessContentIntegrity(`Claim[^1] and[^2] and[^3].

[^1]: Source https://example.com
[^2]: Source https://example.com`);
    // 1 out of 3 refs orphaned = 33% (not >50%, so orphaned-footnotes not severe-truncation)
    const { score, factors } = computeIntegrityRisk(integrity);
    expect(score).toBe(15);
    expect(factors).toContain('orphaned-footnotes');
  });

  it('returns high score for fabricated arxiv IDs', () => {
    const integrity = assessContentIntegrity(
      'Papers: 2506.00001, 2506.00002, 2506.00003'
    );
    const { score, factors } = computeIntegrityRisk(integrity);
    expect(score).toBe(25);
    expect(factors).toContain('suspicious-sequential-ids');
  });

  it('accumulates multiple risk factors', () => {
    // Orphaned footnotes + sequential arxiv IDs + no URLs
    const integrity = assessContentIntegrity(
      `Claim[^1] from 2506.00001, 2506.00002, 2506.00003.

[^1]: No URL here just text.`
    );
    const { score, factors } = computeIntegrityRisk(integrity);
    // orphaned: [^1] has def so no orphans; sequential IDs: +25; unsourced: 1/1 = 100% → +10
    expect(factors).toContain('suspicious-sequential-ids');
    expect(factors).toContain('mostly-unsourced-footnotes');
    expect(score).toBe(35); // 25 + 10
  });
});
